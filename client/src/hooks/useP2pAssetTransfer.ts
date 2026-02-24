/**
 * useP2pAssetTransfer
 *
 * y-webrtc の Data Channel を利用したアセット転送フック。
 * - ホスト: PROJECT_META_REQ / ASSET_REQUEST を受信し、応答を返す
 * - ゲスト: 接続時にプロジェクトメタデータを要求し、必要なアセットをリクエスト
 *
 * y-webrtc の内部 peer connection にフックし、カスタムメッセージ (type >= 100) を横取りする。
 * y-webrtc 側は unknown type を無視するため共存可能。
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import type { WebrtcProvider } from 'y-webrtc';
import {
  MSG,
  encodeJsonMsg,
  encodeChunkMsg,
  readMsgType,
  decodeJsonPayload,
  decodeChunkMsg,
  isCustomMsg,
  splitIntoChunks,
  mergeChunks,
  createIncomingTransfer,
  addChunk,
  transferProgress,
} from '../utils/p2p-asset-protocol';
import type {
  AssetRequestPayload,
  AssetMetaPayload,
  AssetCompletePayload,
  AssetNotFoundPayload,
  ProjectMetaPayload,
  IncomingTransfer,
} from '../utils/p2p-asset-protocol';
import {
  loadAssetFile,
  saveAssetFile,
  saveAssetIndex,
} from '../utils/storage';
import type { StoredAssetFile } from '../utils/storage';
import type { WbAsset, AssetIndex } from '../types';
import { createAssetIndex, addToAssetIndex } from '../types';

// ========================================
// 型
// ========================================

interface UseP2pAssetTransferOptions {
  provider: WebrtcProvider | null;
  isHost: boolean;
  /** ホスト側: アセットインデックスの取得 */
  getAssetIndex?: () => AssetIndex | null;
  /** ゲスト側: プロジェクトメタデータ受信コールバック */
  onProjectMetaReceived?: (index: AssetIndex) => void;
  /** ゲスト側: アセットファイル受信完了コールバック */
  onAssetReceived?: (uuid: string) => void;
}

export interface AssetTransferProgress {
  uuid: string;
  fileName: string;
  progress: number;  // 0.0 - 1.0
  receivedBytes: number;
  totalBytes: number;
}

interface UseP2pAssetTransferReturn {
  /** ゲスト側: アセットをリクエスト */
  requestAsset: (uuid: string) => void;
  /** ゲスト側: プロジェクトメタデータをリクエスト */
  requestProjectMeta: () => void;
  /** 転送進捗（ゲスト側） */
  transferProgress: Map<string, AssetTransferProgress>;
  /** プロジェクトメタデータ受信済みか（ゲスト側） */
  hasProjectMeta: boolean;
}

// ========================================
// simple-peer インスタンスの型（minified なので最小限の定義）
// ========================================

interface SimplePeer {
  send(data: Uint8Array): void;
  on(event: string, cb: (...args: unknown[]) => void): void;
  removeListener(event: string, cb: (...args: unknown[]) => void): void;
  connected: boolean;
  destroyed: boolean;
}

interface WebrtcConn {
  peer: SimplePeer;
  remotePeerId: string;
  connected: boolean;
}

interface Room {
  webrtcConns: Map<string, WebrtcConn>;
  peerId: string;
}

// ========================================
// フック本体
// ========================================

export function useP2pAssetTransfer({
  provider,
  isHost,
  getAssetIndex,
  onProjectMetaReceived,
  onAssetReceived,
}: UseP2pAssetTransferOptions): UseP2pAssetTransferReturn {

  const [progressMap, setProgressMap] = useState<Map<string, AssetTransferProgress>>(new Map());
  const [hasProjectMeta, setHasProjectMeta] = useState(isHost); // ホストは最初から持っている

  // ref でコールバックを保持（useEffect の依存を減らす）
  const getAssetIndexRef = useRef(getAssetIndex);
  useEffect(() => { getAssetIndexRef.current = getAssetIndex; }, [getAssetIndex]);
  const onProjectMetaReceivedRef = useRef(onProjectMetaReceived);
  useEffect(() => { onProjectMetaReceivedRef.current = onProjectMetaReceived; }, [onProjectMetaReceived]);
  const onAssetReceivedRef = useRef(onAssetReceived);
  useEffect(() => { onAssetReceivedRef.current = onAssetReceived; }, [onAssetReceived]);

  // 受信中の転送を追跡
  const incomingTransfersRef = useRef<Map<string, IncomingTransfer>>(new Map());
  // リクエスト済みの UUID を追跡（重複リクエスト防止）
  const requestedUuidsRef = useRef<Set<string>>(new Set());
  // provider ref (send 用)
  const providerRef = useRef(provider);
  useEffect(() => { providerRef.current = provider; }, [provider]);

  // --------------------------------------------------------
  // ホスト → ゲスト: アセット送信
  // --------------------------------------------------------

  const sendAssetToConn = useCallback(async (conn: WebrtcConn, uuid: string) => {
    const file = await loadAssetFile(uuid);
    if (!file) {
      // アセットが見つからない
      try {
        conn.peer.send(encodeJsonMsg(MSG.ASSET_NOT_FOUND, { uuid } satisfies AssetNotFoundPayload));
      } catch { /* peer disconnected */ }
      return;
    }

    const chunks = splitIntoChunks(file.data);

    // 1. メタデータ送信
    const meta: AssetMetaPayload = {
      uuid,
      fileName: file.fileName,
      mimeType: file.mimeType,
      fileSize: file.size,
      totalChunks: chunks.length,
    };
    try {
      conn.peer.send(encodeJsonMsg(MSG.ASSET_META, meta));
    } catch { return; }

    // 2. チャンク送信（バックプレッシャー対応）
    for (let i = 0; i < chunks.length; i++) {
      try {
        conn.peer.send(encodeChunkMsg(uuid, i, chunks[i]));
      } catch { return; }
      // 8 チャンクごとに yield して Data Channel のバッファを逃す
      if ((i + 1) % 8 === 0) {
        await new Promise(r => setTimeout(r, 0));
      }
    }

    // 3. 完了通知
    try {
      conn.peer.send(encodeJsonMsg(MSG.ASSET_COMPLETE, { uuid } satisfies AssetCompletePayload));
    } catch { /* peer disconnected */ }
  }, []);

  // --------------------------------------------------------
  // ホスト → ゲスト: プロジェクトメタデータ送信
  // --------------------------------------------------------

  const sendProjectMetaToConn = useCallback((conn: WebrtcConn) => {
    const index = getAssetIndexRef.current?.();
    if (!index) return;

    const assets: ProjectMetaPayload['assets'] = [];
    for (const [, asset] of index.byUuid) {
      assets.push({
        uuid: asset.uuid,
        type: asset.type,
        originalName: asset.originalName,
        mimeType: asset.mimeType,
        fileSize: asset.fileSize,
        relativePath: asset.relativePath,
        referencedBy: asset.referencedBy,
        allAncestors: asset.allAncestors,
      });
    }

    try {
      conn.peer.send(encodeJsonMsg(MSG.PROJECT_META_RES, { assets } satisfies ProjectMetaPayload));
    } catch { /* peer disconnected */ }
  }, []);

  // --------------------------------------------------------
  // メッセージハンドラ
  // --------------------------------------------------------

  const handleMessage = useCallback((conn: WebrtcConn, raw: Uint8Array | ArrayBuffer) => {
    const data = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    if (!isCustomMsg(data)) return; // y-webrtc メッセージは無視

    const type = readMsgType(data);

    // --- ホスト側: リクエスト受信 ---
    if (isHost) {
      if (type === MSG.ASSET_REQUEST) {
        const payload = decodeJsonPayload<AssetRequestPayload>(data);
        sendAssetToConn(conn, payload.uuid);
      } else if (type === MSG.PROJECT_META_REQ) {
        sendProjectMetaToConn(conn);
      }
      return;
    }

    // --- ゲスト側: レスポンス受信 ---
    if (type === MSG.PROJECT_META_RES) {
      const payload = decodeJsonPayload<ProjectMetaPayload>(data);
      // AssetIndex を構築
      const index = createAssetIndex();
      for (const a of payload.assets) {
        addToAssetIndex(index, {
          uuid: a.uuid,
          type: a.type as WbAsset['type'],
          originalName: a.originalName,
          mimeType: a.mimeType,
          fileSize: a.fileSize,
          relativePath: a.relativePath,
          referencedBy: [...a.referencedBy],
          allAncestors: [...a.allAncestors],
        });
      }
      // IndexedDB に保存
      saveAssetIndex(index).catch(console.error);
      setHasProjectMeta(true);
      onProjectMetaReceivedRef.current?.(index);
      return;
    }

    if (type === MSG.ASSET_META) {
      const meta = decodeJsonPayload<AssetMetaPayload>(data);
      const transfer = createIncomingTransfer(meta);
      incomingTransfersRef.current.set(meta.uuid, transfer);
      // 進捗を更新
      setProgressMap(prev => {
        const next = new Map(prev);
        next.set(meta.uuid, {
          uuid: meta.uuid,
          fileName: meta.fileName,
          progress: 0,
          receivedBytes: 0,
          totalBytes: meta.fileSize,
        });
        return next;
      });
      return;
    }

    if (type === MSG.ASSET_CHUNK) {
      const { uuid, chunkIndex, chunk } = decodeChunkMsg(data);
      const transfer = incomingTransfersRef.current.get(uuid);
      if (!transfer) return;

      const complete = addChunk(transfer, chunkIndex, chunk);
      const prog = transferProgress(transfer);

      // 進捗を更新（10% 刻み or 完了時）
      if (complete || Math.floor(prog * 10) > Math.floor((prog - 1 / transfer.totalChunks) * 10)) {
        setProgressMap(prev => {
          const next = new Map(prev);
          next.set(uuid, {
            uuid,
            fileName: transfer.fileName,
            progress: prog,
            receivedBytes: transfer.receivedBytes,
            totalBytes: transfer.fileSize,
          });
          return next;
        });
      }
      // 完了は ASSET_COMPLETE で処理
      return;
    }

    if (type === MSG.ASSET_COMPLETE) {
      const { uuid } = decodeJsonPayload<AssetCompletePayload>(data);
      const transfer = incomingTransfersRef.current.get(uuid);
      if (!transfer) return;

      // チャンクを結合
      const assembled = mergeChunks(transfer.receivedChunks, transfer.totalChunks);

      // IndexedDB に保存
      const storedFile: StoredAssetFile = {
        uuid: transfer.uuid,
        fileName: transfer.fileName,
        mimeType: transfer.mimeType,
        data: assembled,
        size: assembled.byteLength,
      };
      saveAssetFile(storedFile)
        .then(() => {
          requestedUuidsRef.current.delete(uuid);
          onAssetReceivedRef.current?.(uuid);
        })
        .catch(console.error);

      // 転送バッファをクリーンアップ
      incomingTransfersRef.current.delete(uuid);
      // 進捗を完了に
      setProgressMap(prev => {
        const next = new Map(prev);
        next.delete(uuid); // 完了したら削除
        return next;
      });
      return;
    }

    if (type === MSG.ASSET_NOT_FOUND) {
      const { uuid } = decodeJsonPayload<AssetNotFoundPayload>(data);
      requestedUuidsRef.current.delete(uuid);
      // 進捗から削除
      setProgressMap(prev => {
        const next = new Map(prev);
        next.delete(uuid);
        return next;
      });
      return;
    }
  }, [isHost, sendAssetToConn, sendProjectMetaToConn]);

  // --------------------------------------------------------
  // provider.room.webrtcConns にフック
  // --------------------------------------------------------

  useEffect(() => {
    if (!provider) return;

    // room が非同期で初期化される可能性があるためポーリング
    const hookedConns = new Set<string>();
    const dataHandlers = new Map<string, (data: unknown) => void>();

    const hookConn = (remotePeerId: string, conn: WebrtcConn) => {
      if (hookedConns.has(remotePeerId)) return;
      hookedConns.add(remotePeerId);

      const handler = (raw: unknown) => {
        const data = raw instanceof Uint8Array ? raw :
                     raw instanceof ArrayBuffer ? new Uint8Array(raw) : null;
        if (!data || !isCustomMsg(data)) return;
        handleMessage(conn, data);
      };
      dataHandlers.set(remotePeerId, handler);
      conn.peer.on('data', handler);

      // ゲスト側: 接続確立後にプロジェクトメタデータをリクエスト
      if (!isHost) {
        const sendMetaReq = () => {
          if (conn.peer.destroyed) return;
          try { conn.peer.send(encodeJsonMsg(MSG.PROJECT_META_REQ, {})); } catch { /* ignore */ }
        };
        if (conn.connected && !conn.peer.destroyed) {
          sendMetaReq();
        } else {
          // 接続完了を待ってからリクエスト
          conn.peer.on('connect', sendMetaReq);
        }
      }
    };

    // 既存の接続にフック
    const room = (provider as unknown as { room: Room | null }).room;
    if (room) {
      room.webrtcConns.forEach((conn, peerId) => hookConn(peerId, conn));
    }

    // 新しい peer が接続したらフック
    const onPeers = (evt: { added: string[]; removed: string[]; webrtcPeers: string[] }) => {
      const room = (provider as unknown as { room: Room | null }).room;
      if (!room) return;

      for (const peerId of evt.added) {
        const conn = room.webrtcConns.get(peerId);
        if (conn) {
          hookConn(peerId, conn);
        }
      }

      // 切断したピアのハンドラをクリーンアップ
      for (const peerId of evt.removed) {
        hookedConns.delete(peerId);
        dataHandlers.delete(peerId);
      }
    };
    provider.on('peers', onPeers);

    // ポーリング: room が遅延初期化される場合に対応（最大 3 秒）
    let pollCount = 0;
    const pollInterval = setInterval(() => {
      pollCount++;
      if (pollCount > 30) { clearInterval(pollInterval); return; }
      const room = (provider as unknown as { room: Room | null }).room;
      if (!room) return;
      room.webrtcConns.forEach((conn, peerId) => hookConn(peerId, conn));
    }, 100);

    return () => {
      clearInterval(pollInterval);
      provider.off('peers', onPeers);
      // ハンドラをクリーンアップ
      const room = (provider as unknown as { room: Room | null }).room;
      if (room) {
        dataHandlers.forEach((handler, peerId) => {
          const conn = room.webrtcConns.get(peerId);
          if (conn && !conn.peer.destroyed) {
            conn.peer.removeListener('data', handler);
          }
        });
      }
      hookedConns.clear();
      dataHandlers.clear();
    };
  }, [provider, isHost, handleMessage]);

  // --------------------------------------------------------
  // ゲスト側 API
  // --------------------------------------------------------

  /** アセットリクエスト送信 */
  const requestAsset = useCallback((uuid: string) => {
    if (requestedUuidsRef.current.has(uuid)) return; // 既にリクエスト済み
    requestedUuidsRef.current.add(uuid);

    const prov = providerRef.current;
    if (!prov) return;
    const room = (prov as unknown as { room: Room | null }).room;
    if (!room) return;

    const msg = encodeJsonMsg(MSG.ASSET_REQUEST, { uuid } satisfies AssetRequestPayload);
    // ホストを見つけて送信（全ピアに送っても可だが、ホストのみが応答する）
    room.webrtcConns.forEach(conn => {
      if (conn.connected && !conn.peer.destroyed) {
        try { conn.peer.send(msg); } catch { /* ignore */ }
      }
    });
  }, []);

  /** プロジェクトメタデータリクエスト送信 */
  const requestProjectMeta = useCallback(() => {
    const prov = providerRef.current;
    if (!prov) return;
    const room = (prov as unknown as { room: Room | null }).room;
    if (!room) return;

    const msg = encodeJsonMsg(MSG.PROJECT_META_REQ, {});
    room.webrtcConns.forEach(conn => {
      if (conn.connected && !conn.peer.destroyed) {
        try { conn.peer.send(msg); } catch { /* ignore */ }
      }
    });
  }, []);

  return {
    requestAsset,
    requestProjectMeta,
    transferProgress: progressMap,
    hasProjectMeta,
  };
}
