import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useProjectStore } from '../hooks/useProjectStore';
import { useYjs } from '../hooks/useYjs';
import { WhiteboardCanvas } from '../components/WhiteboardCanvas';
import { Toolbar } from '../components/Toolbar';
import { OverlayInlineControls } from '../components/OverlayInlineControls';
import { ViewportEditor } from '../components/ViewportEditor';
import type { 
  ToolType, 
  StrokeWidthKey, 
  WbelxEvent, 
  SnapshotMarkerEvent,
  OverlayAddEvent,
  OverlayRemoveEvent,
  OverlayTransformEvent,
  OverlayViewportEvent,
  OverlayStyleEvent,
  OverlayState,
  AssetType,
  CanvasTransform,
} from '../types';
import { STROKE_WIDTHS, COLOR_PALETTE, canAddAsOverlay } from '../types';
import { getTimestamp, generateSnapshotId } from '../utils/common';
import {
  saveBoardEvents,
  loadBoardEvents,
  saveBoardSnapshot,
  loadBoardSnapshot,
  deleteBoardSnapshot,
  loadAssetFileAsDataUrl,
} from '../utils/storage';
import { loadPdfDocument, renderPdfPage, getPdfPageCount } from '../utils/pdf';
import { computeState, getActiveStrokes, getActiveOverlays } from '../utils/statemachine';

// 通知の型
interface Notification {
  id: number;
  type: 'join' | 'leave';
  name: string;
}

let notificationIdCounter = 0;

export function BoardEditor() {
  const { boardId } = useParams<{ boardId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { project, getBoardUuid, getAssets, getBoards, onAssetAddedToBoard, onAssetRemovedFromBoard, importAsset, loadBoardEventsAsync, regenerateThumbnail, setBoardCanvasSize } = useProjectStore();

  // ツール状態
  const [tool, setTool] = useState<ToolType>('pen');
  const [color, setColor] = useState<string>(COLOR_PALETTE[0]);
  const [strokeWidthKey, setStrokeWidthKey] = useState<StrokeWidthKey>('medium');
  
  // 初期イベント
  const [initialEvents, setInitialEvents] = useState<WbelxEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  
  // 通知
  const [notifications, setNotifications] = useState<Notification[]>([]);
  
  // オーバーレイ関連
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  const [overlayImages, setOverlayImages] = useState<Map<string, HTMLImageElement>>(new Map());
  // overlayId ごとの「最後にレンダリングしたキー」を管理（変更検知用）
  const overlayRenderKeyRef = useRef<Map<string, string>>(new Map());
  // WhiteboardCanvas の現在の transform（ズームレベル変化でボードサムネイルを再生成する）
  // インラインコントロール用
  const [overlayOpacityOverrides, setOverlayOpacityOverrides] = useState<Map<string, number>>(new Map());
  /** overlayId → AR ロック設定（デフォルト true）。ViewportEditor の適用で更新。 */
  const [overlayLockAspectRatios, setOverlayLockAspectRatios] = useState<Map<string, boolean>>(new Map());
  /** 画像再生成中の overlayId セット（スピナー表示用） */
  const [loadingOverlayIds, setLoadingOverlayIds] = useState<Set<string>>(new Set());
  /** アセットが見つからない overlayId セット（Missing Asset プレースホルダー用） */
  const [missingOverlayIds, setMissingOverlayIds] = useState<Set<string>>(new Set());
  // インラインコントロールの位置計算用：transform をリアルタイムで反映（パン・ズーム追随）
  const [canvasTransformFull, setCanvasTransformFull] = useState<CanvasTransform>({ x: 0, y: 0, scale: 1 });
  // サムネイル再生成用：ズームティア変化時のみ更新
  const [canvasTransform, setCanvasTransform] = useState<CanvasTransform>({ x: 0, y: 0, scale: 1 });
  // ズームティアが変化したときのみ canvasTransform を更新（サムネイル再生成をスロットリング）
  const lastZoomTierRef = useRef(0);
  const handleTransformChange = useCallback((t: CanvasTransform) => {
    // インラインコントロール用は常時更新
    setCanvasTransformFull(t);
    // サムネイル再生成はズームティア変化時のみ
    const newTier = Math.ceil(Math.log2(Math.max(t.scale, 0.01)));
    if (newTier !== lastZoomTierRef.current) {
      lastZoomTierRef.current = newTier;
      setCanvasTransform(t);
    }
  }, []);
  
  // ViewportEditor
  const [viewportEditorOverlayId, setViewportEditorOverlayId] = useState<string | null>(null);
  const [pdfPageCounts, setPdfPageCounts] = useState<Map<string, number>>(new Map());

  // ボード情報
  const boardInfo = boardId ? project?.config.boards.get(boardId) : undefined;
  const localBoardUuid = boardId ? getBoardUuid(boardId) : undefined;

  // 固定キャンバスサイズ（undefined = 無限キャンバス）
  const canvasSize = useMemo(() => {
    if (boardInfo?.canvasWidth && boardInfo?.canvasHeight) {
      return { width: boardInfo.canvasWidth, height: boardInfo.canvasHeight };
    }
    return undefined;
  }, [boardInfo?.canvasWidth, boardInfo?.canvasHeight]);
  
  // 共有リンク判定
  const roomIdFromQuery = searchParams.get('room');
  const isJoiningViaShareLink = !!roomIdFromQuery;
  const isHost = !!project && !isJoiningViaShareLink;
  
  const roomId = useMemo(() => {
    return roomIdFromQuery || localBoardUuid || '';
  }, [roomIdFromQuery, localBoardUuid]);

  // 最後に保存したイベント数（重複保存防止）
  const lastSavedEventCountRef = useRef(0);
  
  // 通知を追加
  const addNotification = useCallback((type: 'join' | 'leave', name: string) => {
    const id = ++notificationIdCounter;
    setNotifications((prev: Notification[]) => [...prev, { id, type, name }]);
    // 3秒後に自動削除
    setTimeout(() => {
      setNotifications((prev: Notification[]) => prev.filter((n: Notification) => n.id !== id));
    }, 3000);
  }, []);
  
  // ピア接続/切断コールバック
  const handlePeerJoin = useCallback((name: string) => {
    addNotification('join', name);
  }, [addNotification]);
  
  const handlePeerLeave = useCallback((name: string) => {
    addNotification('leave', name);
  }, [addNotification]);

  // ========================================
  // 1. ボードを開いたとき：IndexedDB から読み込む
  // ========================================
  useEffect(() => {
    if (!isHost || !boardId) {
      setIsLoading(false);
      return;
    }

    const load = async () => {
      try {
        
        // スナップショットを確認
        const snapshot = await loadBoardSnapshot(boardId);
        if (snapshot && snapshot.length > 0) {
          setInitialEvents(snapshot);
          setIsLoading(false);
          return;
        }
        
        // なければイベントログを読み込む
        const events = await loadBoardEvents(boardId);
        // S イベントを除去
        const filtered = events.filter(e => e.type !== 'S');
        setInitialEvents(filtered);
        setIsLoading(false);
      } catch (error) {
        console.error('[BoardEditor] Load error:', error);
        setLoadError(error instanceof Error ? error.message : 'Failed to load');
        setIsLoading(false);
      }
    };

    load();
  }, [isHost, boardId]);

  // P2P コラボレーション
  const {
    isConnected,
    peerCount,
    activeStrokes,
    activeOverlays,
    cursors,
    sessionId,
    addDrawEvent,
    addEraseEvent,
    addOverlayEvent,
    removeOverlayEvent,
    transformOverlayEvent,
    viewportOverlayEvent,
    styleOverlayEvent,
    performUndo,
    performRedo,
    canUndo,
    canRedo,
    updateCursor,
    hideCursor,
    exportWbelx,
    exportSnapshotWbelx,
    hasContent,
    isJoiningRoom,
    peerSearchTimedOut,
    hasSyncedData,
    isHostConnected,
    guestsPresent,
    events,
    // アセット転送
    incomingAssetRequests,
    receivedAssets,
    requestAsset,
    sendAssetResponse,
    clearAssetRequest,
  } = useYjs({
    roomId,
    enabled: !!roomId && !isLoading,
    isHost,
    initialEvents,
    onPeerJoin: handlePeerJoin,
    onPeerLeave: handlePeerLeave,
  });

  // ========================================
  // オーバーレイ画像の読み込み
  // overlayImages は overlayId をキーとする。
  // レンダリングキー（assetUuid + page + viewport）が変化した場合に再生成。
  // ========================================
  useEffect(() => {
    // ----------------------------------------------------------------
    // ヘルパー: 生画像キャッシュ（assetUuid → HTMLImageElement）
    // ----------------------------------------------------------------
    const rawImageCache = new Map<string, HTMLImageElement>();
    const pdfPageCache = new Map<string, HTMLImageElement>(); // key: assetUuid:page

    const loadRawImage = async (assetUuid: string): Promise<HTMLImageElement | null> => {
      if (rawImageCache.has(assetUuid)) return rawImageCache.get(assetUuid)!;
      const dataUrl = await loadAssetFileAsDataUrl(assetUuid);
      if (!dataUrl) return null;
      const img = new Image();
      img.src = dataUrl;
      await new Promise<void>(r => { img.onload = () => r(); img.onerror = () => r(); });
      rawImageCache.set(assetUuid, img);
      return img;
    };

    const loadPdfPage = async (assetUuid: string, page: number): Promise<HTMLImageElement | null> => {
      const key = `${assetUuid}:${page}`;
      if (pdfPageCache.has(key)) return pdfPageCache.get(key)!;
      const dataUrl = await loadAssetFileAsDataUrl(assetUuid);
      if (!dataUrl) return null;
      try {
        const pdfDoc = await loadPdfDocument(dataUrl);
        const img = await renderPdfPage(pdfDoc, page > 0 ? page : 1);
        pdfPageCache.set(key, img);
        return img;
      } catch { return null; }
    };

    // ----------------------------------------------------------------
    // ヘルパー: ボードをオフスクリーン canvas にレンダリング（再帰対応）
    // overlayHint: サムネイル解像度を決めるための表示サイズヒント
    // ----------------------------------------------------------------
    const renderBoardToImage = async (
      boardOverlayState: { assetUuid: string; viewport: { x: number; y: number; width: number; height: number }; width: number; height: number; displayScale: number },
      depth: number
    ): Promise<HTMLImageElement | null> => {
      if (depth > 6) return null; // 最大再帰深度（循環参照は canAddAsOverlay で防いでいるため深くてOK）

      // ボード ID を assetUuid から逆引き
      const boards = getBoards();
      let targetBoardId: string | null = null;
      for (const board of boards) {
        if (getBoardUuid(board.id) === boardOverlayState.assetUuid) {
          targetBoardId = board.id;
          break;
        }
      }
      if (!targetBoardId) return null;

      // イベント読み込み（snapshot 優先）
      let events: WbelxEvent[];
      try {
        const snapshotEvents = await loadBoardSnapshot(targetBoardId);
        events = snapshotEvents?.length ? snapshotEvents : await loadBoardEventsAsync(targetBoardId);
      } catch { return null; }

      const boardState = computeState(events);
      const boardStrokes = getActiveStrokes(boardState);
      const boardSubOverlays = getActiveOverlays(boardState);

      // 描画範囲の決定
      const vp = boardOverlayState.viewport;
      const hasVp = vp.width > 0 && vp.height > 0;
      let minX: number, minY: number, maxX: number, maxY: number;

      if (hasVp) {
        minX = vp.x; minY = vp.y;
        maxX = vp.x + vp.width; maxY = vp.y + vp.height;
      } else {
        // コンテンツ BBox を計算
        minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
        for (const s of boardStrokes) {
          if (s.bbox) {
            minX = Math.min(minX, s.bbox[0]); minY = Math.min(minY, s.bbox[1]);
            maxX = Math.max(maxX, s.bbox[2]); maxY = Math.max(maxY, s.bbox[3]);
          }
        }
        for (const o of boardSubOverlays) {
          minX = Math.min(minX, o.x); minY = Math.min(minY, o.y);
          maxX = Math.max(maxX, o.x + o.width); maxY = Math.max(maxY, o.y + o.height);
        }
        if (minX === Infinity) { minX = -960; minY = -540; maxX = 960; maxY = 540; }
      }

      const contentW = Math.max(maxX - minX, 1);
      const contentH = Math.max(maxY - minY, 1);

      // サムネイルサイズ: overlay の実際の表示ピクセル数基準で高解像度生成、上限 4096px
      const aspect = contentW / contentH;
      const displayW = boardOverlayState.width * boardOverlayState.displayScale;
      const thumbW = Math.min(Math.ceil(displayW * (window.devicePixelRatio || 1) * 1.5), 4096);
      const thumbH = Math.round(thumbW / aspect);
      const scale = thumbW / contentW;

      const thumbCanvas = document.createElement('canvas');
      thumbCanvas.width = thumbW;
      thumbCanvas.height = thumbH;
      const ctx = thumbCanvas.getContext('2d')!;

      // 背景
      const bg = project?.config.background;
      ctx.fillStyle = bg?.color || '#ffffff';
      ctx.fillRect(0, 0, thumbW, thumbH);

      // 背景パターン
      const bgPattern = bg?.pattern || 'none';
      if (bgPattern !== 'none') {
        ctx.save();
        ctx.scale(scale, scale);
        ctx.translate(-minX, -minY);
        const gridSize = bg?.patternSize || 20;
        ctx.strokeStyle = bg?.patternColor || '#e0e0e0';
        ctx.fillStyle = bg?.patternColor || '#e0e0e0';
        ctx.lineWidth = 1 / scale;
        const gx0 = Math.floor(minX / gridSize) * gridSize;
        const gy0 = Math.floor(minY / gridSize) * gridSize;
        if (bgPattern === 'grid' || bgPattern === 'lines') {
          ctx.beginPath();
          for (let y = gy0; y <= maxY; y += gridSize) { ctx.moveTo(minX, y); ctx.lineTo(maxX, y); }
          if (bgPattern === 'grid') {
            for (let x = gx0; x <= maxX; x += gridSize) { ctx.moveTo(x, minY); ctx.lineTo(x, maxY); }
          }
          ctx.stroke();
        }
        if (bgPattern === 'dots') {
          const radius = Math.max(1 / scale, 0.8);
          for (let x = gx0; x <= maxX; x += gridSize) {
            for (let y = gy0; y <= maxY; y += gridSize) {
              ctx.beginPath();
              ctx.arc(x, y, radius, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }
        ctx.restore();
      }

      // サブオーバーレイのアセットタイプをマップで管理（描画時に board と非board を区別）
      const subAssetTypeMap = new Map<string, AssetType>();
      for (const subOv of boardSubOverlays) {
        const subAsset = project?.assetIndex.byUuid.get(subOv.assetUuid);
        subAssetTypeMap.set(subOv.overlayId, subAsset?.type ?? 'image');
      }

      // サブオーバーレイ画像を並列ロード
      const subImgMap = new Map<string, HTMLImageElement>();
      await Promise.all(boardSubOverlays.map(async (subOv) => {
        const subAsset = project?.assetIndex.byUuid.get(subOv.assetUuid);
        if (!subAsset) return;
        let subImg: HTMLImageElement | null = null;
        try {
          if (subAsset.type === 'image') {
            subImg = await loadRawImage(subOv.assetUuid);
          } else if (subAsset.type === 'document') {
            subImg = await loadPdfPage(subOv.assetUuid, subOv.page > 0 ? subOv.page : 1);
          } else if (subAsset.type === 'board') {
            subImg = await renderBoardToImage(
              { assetUuid: subOv.assetUuid, viewport: subOv.viewport, width: subOv.width, height: subOv.height, displayScale: boardOverlayState.displayScale },
              depth + 1
            );
          }
        } catch { /* skip */ }
        if (subImg) subImgMap.set(subOv.overlayId, subImg);
      }));

      // オーバーレイを描画
      ctx.save();
      ctx.scale(scale, scale);
      ctx.translate(-minX, -minY);
      for (const subOv of boardSubOverlays) {
        const subImg = subImgMap.get(subOv.overlayId);
        const subAssetType = subAssetTypeMap.get(subOv.overlayId) ?? 'image';
        ctx.save();
        ctx.globalAlpha = subOv.opacity;
        if (subImg && subImg.complete) {
          // board タイプはサムネイルに viewport 範囲が既に焼き込まれているので source rect を使わない
          // image/document タイプは viewport を source rect として使うことで正確なクリッピング
          if (subAssetType !== 'board' && subOv.viewport.width > 0 && subOv.viewport.height > 0) {
            ctx.drawImage(
              subImg,
              subOv.viewport.x, subOv.viewport.y, subOv.viewport.width, subOv.viewport.height,
              subOv.x, subOv.y, subOv.width, subOv.height
            );
          } else {
            ctx.drawImage(subImg, subOv.x, subOv.y, subOv.width, subOv.height);
          }
        } else {
          // プレースホルダー
          ctx.fillStyle = '#d1d5db';
          ctx.fillRect(subOv.x, subOv.y, subOv.width, subOv.height);
        }
        ctx.restore();
      }
      ctx.restore();

      // ストローク描画
      ctx.save();
      ctx.scale(scale, scale);
      ctx.translate(-minX, -minY);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const stroke of boardStrokes) {
        ctx.strokeStyle = stroke.color;
        ctx.lineWidth = stroke.width;
        ctx.stroke(new Path2D(stroke.path));
      }
      ctx.restore();

      // HTMLImageElement に変換
      const resultImg = new Image();
      resultImg.src = thumbCanvas.toDataURL('image/png');
      await new Promise<void>(r => { resultImg.onload = () => r(); });
      return resultImg;
    };

    // ----------------------------------------------------------------
    // メイン: 各 overlay のレンダリングキーを確認し、必要なものを再生成
    // ----------------------------------------------------------------
    const loadImages = async () => {
      const newImages = new Map<string, HTMLImageElement>(); // overlayId → image
      const missingUuids: string[] = [];
      const newMissingOverlayIds = new Set<string>();

      for (const overlay of activeOverlays) {
        const asset = project?.assetIndex.byUuid.get(overlay.assetUuid);
        const assetType = asset?.type ?? 'image';

        // レンダリングキー（viewport + page + assetUuid + zoomTier が変わったら再生成）
        // zoomTier: ボードサムネイルのみ対象。log2 で 2 段階ごとに再生成（0.5x, 1x, 2x, 4x...）
        const displayPixels = overlay.width * canvasTransform.scale;
        const zoomTier = assetType === 'board' ? Math.ceil(Math.log2(Math.max(displayPixels, 1))) : 0;
        const vpKey = `${overlay.viewport.x},${overlay.viewport.y},${overlay.viewport.width},${overlay.viewport.height}`;
        const renderKey = assetType === 'board'
          ? `board:${overlay.assetUuid}:${vpKey}:z${zoomTier}`
          : assetType === 'document'
          ? `pdf:${overlay.assetUuid}:${overlay.page || 1}`
          : `img:${overlay.assetUuid}`;

        const prevKey = overlayRenderKeyRef.current.get(overlay.overlayId);
        const prevImg = overlayImages.get(overlay.overlayId);

        if (prevKey === renderKey && prevImg) {
          // 変更なし → 既存の image を再利用
          newImages.set(overlay.overlayId, prevImg);
          continue;
        }

        // --- 再生成が必要 ---
        let img: HTMLImageElement | null = null;

        if (assetType === 'board') {
          img = await renderBoardToImage(
            { assetUuid: overlay.assetUuid, viewport: overlay.viewport, width: overlay.width, height: overlay.height, displayScale: canvasTransform.scale },
            0
          );
          if (!img) {
            newMissingOverlayIds.add(overlay.overlayId);
          }

        } else if (assetType === 'document') {
          // P2P receivedAssets からも試みる
          let dataUrl = await loadAssetFileAsDataUrl(overlay.assetUuid);
          if (!dataUrl) {
            const received = receivedAssets.get(overlay.assetUuid);
            if (received) {
              dataUrl = `data:${received.mimeType};base64,${received.data}`;
              clearAssetRequest(overlay.assetUuid);
            }
          }
          if (dataUrl) {
            try {
              const pdfDoc = await loadPdfDocument(dataUrl);
              img = await renderPdfPage(pdfDoc, overlay.page > 0 ? overlay.page : 1);
              pdfPageCache.set(`${overlay.assetUuid}:${overlay.page || 1}`, img);
            } catch { /* skip */ }
          } else {
            missingUuids.push(overlay.assetUuid);
            newMissingOverlayIds.add(overlay.overlayId);
          }

        } else { // image
          // P2P receivedAssets からも試みる
          img = await loadRawImage(overlay.assetUuid);
          if (!img) {
            const received = receivedAssets.get(overlay.assetUuid);
            if (received) {
              const fullDataUrl = `data:${received.mimeType};base64,${received.data}`;
              const rImg = new Image();
              rImg.src = fullDataUrl;
              await new Promise<void>(r => { rImg.onload = () => r(); rImg.onerror = () => r(); });
              rawImageCache.set(overlay.assetUuid, rImg);
              img = rImg;
              clearAssetRequest(overlay.assetUuid);
            } else {
              missingUuids.push(overlay.assetUuid);
              newMissingOverlayIds.add(overlay.overlayId);
            }
          }
        }

        if (img) {
          newImages.set(overlay.overlayId, img);
          overlayRenderKeyRef.current.set(overlay.overlayId, renderKey);
        }
      }

      // 不足アセットをリクエスト（P2P）
      for (const uuid of missingUuids) requestAsset(uuid);

      setOverlayImages(newImages);
      setMissingOverlayIds(newMissingOverlayIds);
      // 再生成が完了した overlayId を loading から除外
      if (missingUuids.length === 0) {
        setLoadingOverlayIds((prev: Set<string>) => {
          if (prev.size === 0) return prev;
          const next = new Set<string>(prev);
          for (const id of next) {
            if (newImages.has(id)) next.delete(id);
          }
          return next.size === prev.size ? prev : next;
        });
      }
    };

    loadImages();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeOverlays, receivedAssets, canvasTransform]);

  // PDF のページ数を取得
  useEffect(() => {
    const loadPageCounts = async () => {
      const newCounts = new Map<string, number>();
      
      for (const overlay of activeOverlays) {
        // 既に取得済みならスキップ
        if (pdfPageCounts.has(overlay.assetUuid)) {
          newCounts.set(overlay.assetUuid, pdfPageCounts.get(overlay.assetUuid)!);
          continue;
        }
        
        // PDF かどうか確認
        const asset = project?.assetIndex.byUuid.get(overlay.assetUuid);
        if (asset?.type !== 'document') continue;
        
        try {
          const dataUrl = await loadAssetFileAsDataUrl(overlay.assetUuid);
          if (dataUrl) {
            const pdfDoc = await loadPdfDocument(dataUrl);
            newCounts.set(overlay.assetUuid, getPdfPageCount(pdfDoc));
          }
        } catch (error) {
          console.warn('Failed to get PDF page count:', overlay.assetUuid, error);
        }
      }
      
      if (newCounts.size > 0) {
        setPdfPageCounts((prev: Map<string, number>) => new Map([...prev, ...newCounts]));
      }
    };
    
    loadPageCounts();
  }, [activeOverlays, project]);

  // ========================================
  // アセットリクエストへの応答（ホスト側）
  // ========================================
  useEffect(() => {
    if (incomingAssetRequests.length === 0) return;
    
    const respondToRequests = async () => {
      for (const uuid of incomingAssetRequests) {
        // 自分が持っているか確認
        const dataUrl = await loadAssetFileAsDataUrl(uuid);
        if (dataUrl) {
          // data:image/png;base64,xxxx の形式からBase64部分を抽出
          const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            const mimeType = match[1];
            const base64Data = match[2];
            sendAssetResponse(uuid, base64Data, mimeType);
          }
        }
      }
    };
    
    respondToRequests();
  }, [incomingAssetRequests, sendAssetResponse]);

  // アセット追加ハンドラ
  const handleAddAsset = useCallback(async (assetUuid: string) => {
    const asset = project?.assetIndex.byUuid.get(assetUuid);
    const assetType = asset?.type || 'image';

    const DEFAULT_W = 300;
    const DEFAULT_H = 200;
    const DEFAULT_CX = 250;
    const DEFAULT_CY = 200;
    const DEFAULT_AREA = DEFAULT_W * DEFAULT_H;

    // rendering 設定（project から取得、なければデフォルト）
    const margin   = project?.config.rendering.boardOverlayMargin ?? 50;
    const fallback = project?.config.rendering.boardOverlayFallbackViewport
      ?? { x: -960, y: -540, width: 1920, height: 1080 };

    let width = DEFAULT_W;
    let height = DEFAULT_H;
    // board overlay の viewport（センチネル廃止: 必ず実際の値を設定）
    let overlayViewport = { x: 0, y: 0, width: 0, height: 0 };

    if (assetType === 'document') {
      try {
        const dataUrl = await loadAssetFileAsDataUrl(assetUuid);
        if (dataUrl) {
          const pdfDoc = await loadPdfDocument(dataUrl);
          const page = await pdfDoc.getPage(1);
          const vp = page.getViewport({ scale: 1 });
          const ar = vp.width / vp.height;
          width  = Math.round(Math.sqrt(DEFAULT_AREA * ar));
          height = Math.round(Math.sqrt(DEFAULT_AREA / ar));
        }
      } catch (error) {
        console.warn('Failed to get PDF dimensions:', error);
      }

    } else if (assetType === 'board') {
      try {
        const boards = getBoards();
        let boardId: string | null = null;
        for (const board of boards) {
          if (getBoardUuid(board.id) === assetUuid) { boardId = board.id; break; }
        }
        if (boardId) {
          const snap = await loadBoardSnapshot(boardId);
          const events = snap?.length ? snap : await loadBoardEventsAsync(boardId);
          const state = computeState(events);
          const boardStrokes = getActiveStrokes(state);
          const boardOverlays = getActiveOverlays(state);

          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const s of boardStrokes) {
            if (s.bbox) {
              minX = Math.min(minX, s.bbox[0]); minY = Math.min(minY, s.bbox[1]);
              maxX = Math.max(maxX, s.bbox[2]); maxY = Math.max(maxY, s.bbox[3]);
            }
          }
          for (const o of boardOverlays) {
            minX = Math.min(minX, o.x); minY = Math.min(minY, o.y);
            maxX = Math.max(maxX, o.x + o.width); maxY = Math.max(maxY, o.y + o.height);
          }

          if (minX !== Infinity) {
            // コンテンツ BBox + margin を viewport として設定
            overlayViewport = {
              x:      minX - margin,
              y:      minY - margin,
              width:  maxX - minX + margin * 2,
              height: maxY - minY + margin * 2,
            };
          } else {
            // コンテンツが空 → fallback viewport
            overlayViewport = { ...fallback };
          }

          // overlay のサイズは viewport のアスペクト比に合わせる
          const ar = overlayViewport.width / overlayViewport.height;
          width  = Math.round(Math.sqrt(DEFAULT_AREA * ar));
          height = Math.round(Math.sqrt(DEFAULT_AREA / ar));
        }
      } catch (error) {
        console.warn('Failed to get board dimensions:', error);
      }
    }

    const x = Math.round(DEFAULT_CX - width  / 2);
    const y = Math.round(DEFAULT_CY - height / 2);

    const event: OverlayAddEvent = {
      type: 'OA',
      timestamp: getTimestamp(),
      sessionId,
      overlayId: `o:${Date.now().toString(36)}`,
      assetUuid,
      x,
      y,
      width,
      height,
      rotation: 0,
      viewport: overlayViewport,
      page: 1,
      zIndex: activeOverlays.length + 1,
      opacity: 1.0,
    };
    addOverlayEvent(event);

    if (localBoardUuid) {
      onAssetAddedToBoard(localBoardUuid, assetUuid);
    }
  }, [sessionId, activeOverlays.length, addOverlayEvent, localBoardUuid, onAssetAddedToBoard, project, getBoards, getBoardUuid, loadBoardSnapshot, loadBoardEventsAsync]);

  // オーバーレイ削除ハンドラ
  const handleRemoveOverlay = useCallback((event: OverlayRemoveEvent) => {
    // 削除対象のオーバーレイデータを取得
    const targetOverlays: OverlayAddEvent[] = [];
    const removedAssetUuids: string[] = [];
    
    for (const overlayId of event.targetOverlayIds) {
      const overlay = activeOverlays.find(o => o.overlayId === overlayId);
      if (overlay) {
        targetOverlays.push({
          type: 'OA',
          timestamp: '',
          sessionId: '',
          overlayId: overlay.overlayId,
          assetUuid: overlay.assetUuid,
          x: overlay.x,
          y: overlay.y,
          width: overlay.width,
          height: overlay.height,
          rotation: overlay.rotation,
          viewport: overlay.viewport,
          page: overlay.page,
          zIndex: overlay.zIndex,
          opacity: overlay.opacity,
        });
        removedAssetUuids.push(overlay.assetUuid);
      }
    }
    removeOverlayEvent(event, targetOverlays);
    
    // アセット参照を更新（ボードネスト用）
    if (localBoardUuid) {
      for (const assetUuid of removedAssetUuids) {
        // 同じアセットの他のオーバーレイが残っていないか確認
        const otherOverlays = activeOverlays.filter(
          o => o.assetUuid === assetUuid && !event.targetOverlayIds.includes(o.overlayId)
        );
        if (otherOverlays.length === 0) {
          onAssetRemovedFromBoard(localBoardUuid, assetUuid);
        }
      }
    }
  }, [activeOverlays, removeOverlayEvent, localBoardUuid, onAssetRemovedFromBoard]);

  // 選択中のオーバーレイ情報（インラインコントロール用、後で使用）
  // const selectedOverlay = useMemo(() => {
  //   if (!selectedOverlayId) return null;
  //   return activeOverlays.find(o => o.overlayId === selectedOverlayId) || null;
  // }, [selectedOverlayId, activeOverlays]);

  // 選択中オーバーレイのアセットタイプ（インラインコントロール用、後で使用）
  // const selectedOverlayAssetType = useMemo((): AssetType | null => {
  //   if (!selectedOverlay || !project) return null;
  //   const asset = project.assetIndex.byUuid.get(selectedOverlay.assetUuid);
  //   return asset?.type || null;
  // }, [selectedOverlay, project]);

  // インラインコントロールからページ変更（後で使用）
  // const handlePageChange = useCallback((newPage: number) => {
  //   if (!selectedOverlay) return;
  //   
  //   const event: OverlayViewportEvent = {
  //     type: 'OV',
  //     timestamp: getTimestamp(),
  //     sessionId,
  //     overlayId: selectedOverlay.overlayId,
  //     viewport: selectedOverlay.viewport,
  //     page: newPage,
  //   };
  //   
  //   viewportOverlayEvent(event, {
  //     viewport: selectedOverlay.viewport,
  //     page: selectedOverlay.page,
  //   });
  // }, [selectedOverlay, sessionId, viewportOverlayEvent]);

  // ViewportEditor を開く（ダブルクリックで直接開くので一旦コメントアウト）
  // const handleOpenViewportEditor = useCallback(() => {
  //   if (selectedOverlayId) {
  //     setViewportEditorOverlayId(selectedOverlayId);
  //   }
  // }, [selectedOverlayId]);

  // ViewportEditor を閉じる
  const handleCloseViewportEditor = useCallback(() => {
    setViewportEditorOverlayId(null);
    // ドラッグ状態をリセットするため、選択も解除
    setSelectedOverlayId(null);
  }, []);

  // ViewportEditor の適用
  const handleApplyViewport = useCallback((
    viewport: { x: number; y: number; width: number; height: number },
    page: number,
    newAssetUuid?: string,
    overlayTransform?: { x: number; y: number; width: number; height: number },
    _naturalSize?: { width: number; height: number },
    lockAspectRatio?: boolean,
    initialBoardViewport?: { x: number; y: number; width: number; height: number },
  ) => {
    const overlay = activeOverlays.find(o => o.overlayId === viewportEditorOverlayId);
    if (!overlay) return;
    
    if (newAssetUuid && newAssetUuid !== overlay.assetUuid) {
      // アセット変更の場合: OR + OA イベント
      // 古いオーバーレイを削除
      const removeEvent: OverlayRemoveEvent = {
        type: 'OR',
        timestamp: getTimestamp(),
        sessionId,
        removeId: `r:${Date.now().toString(36)}`,
        targetOverlayIds: [overlay.overlayId],
      };
      removeOverlayEvent(removeEvent, [{
        type: 'OA',
        timestamp: '',
        sessionId: '',
        overlayId: overlay.overlayId,
        assetUuid: overlay.assetUuid,
        x: overlay.x,
        y: overlay.y,
        width: overlay.width,
        height: overlay.height,
        rotation: overlay.rotation,
        viewport: overlay.viewport,
        page: overlay.page,
        zIndex: overlay.zIndex,
        opacity: overlay.opacity,
      }]);
      
      // 新しいオーバーレイを追加（overlayTransform があれば適用）
      const newX = overlayTransform?.x ?? overlay.x;
      const newY = overlayTransform?.y ?? overlay.y;
      const newWidth = overlayTransform?.width ?? overlay.width;
      const newHeight = overlayTransform?.height ?? overlay.height;
      
      const addEvent: OverlayAddEvent = {
        type: 'OA',
        timestamp: getTimestamp(),
        sessionId,
        overlayId: `o:${Date.now().toString(36)}`,
        assetUuid: newAssetUuid,
        x: newX,
        y: newY,
        width: newWidth,
        height: newHeight,
        rotation: overlay.rotation,
        viewport,
        page,
        zIndex: overlay.zIndex,
        opacity: overlay.opacity,
      };
      addOverlayEvent(addEvent);
      
      // アセット参照を更新
      if (localBoardUuid) {
        onAssetRemovedFromBoard(localBoardUuid, overlay.assetUuid);
        onAssetAddedToBoard(localBoardUuid, newAssetUuid);
      }
    } else {
      // アセット変更なし

      // -------------------------------------------------------
      // 仮想全体表示を保持する overlay 位置・サイズの再計算
      //
      // image/document: ViewportEditor 側で計算済みの overlayTransform を使用
      // board:          ここで計算する（自然サイズが無限なので vpOld を基準にする）
      // -------------------------------------------------------
      let finalOverlayTransform = overlayTransform;

      const assetType = project?.assetIndex.byUuid.get(overlay.assetUuid)?.type;
      if (assetType === 'board') {
        // vpOld の優先順:
        //   1. initialBoardViewport: applyInitialFit が決定した実効初期 viewport（最も正確）
        //   2. overlay.viewport:     前回 apply 済みの viewport
        //   3. DEFAULT_BOARD_VIEWPORT: 上記いずれも使えない場合のフォールバック
        const vpOld =
          (initialBoardViewport && initialBoardViewport.width > 0)
            ? initialBoardViewport
            : (overlay.viewport.width > 0 && overlay.viewport.height > 0)
              ? overlay.viewport
              : { x: -960, y: -540, width: 1920, height: 1080 };
        const vpNew = viewport;

        // 仮想全体表示のスケール（ボード座標 1 単位 = WB 上の何 px か）
        const sx = overlay.width  / vpOld.width;
        const sy = overlay.height / vpOld.height;

        // 仮想全体表示の WB 上の原点
        const tx = overlay.x - vpOld.x * sx;
        const ty = overlay.y - vpOld.y * sy;

        // 新しい viewport を適用した overlay の WB 座標
        const newX = tx + vpNew.x * sx;
        const newY = ty + vpNew.y * sy;
        const newW = vpNew.width  * sx;
        const newH = vpNew.height * sy;

        // 変化がある場合のみ overlayTransform を設定
        const unchanged =
          Math.abs(newX - overlay.x) < 0.5 &&
          Math.abs(newY - overlay.y) < 0.5 &&
          Math.abs(newW - overlay.width) < 0.5 &&
          Math.abs(newH - overlay.height) < 0.5;

        if (!unchanged) {
          finalOverlayTransform = {
            x: Math.round(newX),
            y: Math.round(newY),
            width:  Math.max(1, Math.round(newW)),
            height: Math.max(1, Math.round(newH)),
          };
        }
      }

      // overlayTransform がある場合は OT イベントも発行
      if (finalOverlayTransform) {
        const transformEvent: OverlayTransformEvent = {
          type: 'OT',
          timestamp: getTimestamp(),
          sessionId,
          overlayId: overlay.overlayId,
          x: finalOverlayTransform.x,
          y: finalOverlayTransform.y,
          width: finalOverlayTransform.width,
          height: finalOverlayTransform.height,
          rotation: overlay.rotation,
        };
        transformOverlayEvent(transformEvent, {
          x: overlay.x,
          y: overlay.y,
          width: overlay.width,
          height: overlay.height,
          rotation: overlay.rotation,
        });
      }

      // viewport/page 変更
      const event: OverlayViewportEvent = {
        type: 'OV',
        timestamp: getTimestamp(),
        sessionId,
        overlayId: overlay.overlayId,
        viewport,
        page,
      };

      viewportOverlayEvent(event, {
        viewport: overlay.viewport,
        page: overlay.page,
      });
    }
    
    setViewportEditorOverlayId(null);
    // renderKey キャッシュを削除 → 次の loadImages で必ず再生成される
    overlayRenderKeyRef.current.delete(overlay.overlayId);
    // ローディング表示を開始
    setLoadingOverlayIds((prev: Set<string>) => new Set([...prev, overlay.overlayId]));
    // AR ロック設定を保存
    if (lockAspectRatio !== undefined && overlay.overlayId) {
      setOverlayLockAspectRatios((prev: Map<string, boolean>) => new Map([...prev, [overlay.overlayId, lockAspectRatio]]));
    }
    // ドラッグ状態をリセットするため、選択も解除
    setSelectedOverlayId(null);
  }, [activeOverlays, viewportEditorOverlayId, sessionId, removeOverlayEvent, addOverlayEvent, transformOverlayEvent, viewportOverlayEvent, localBoardUuid, onAssetRemovedFromBoard, onAssetAddedToBoard, project]);

  // ViewportEditor 用のオーバーレイ情報
  const viewportEditorOverlay = useMemo(() => {
    if (!viewportEditorOverlayId) return null;
    return activeOverlays.find(o => o.overlayId === viewportEditorOverlayId) || null;
  }, [viewportEditorOverlayId, activeOverlays]);

  // インラインコントロール: 選択中のオーバーレイ情報
  const selectedOverlay = useMemo(() => {
    if (!selectedOverlayId) return null;
    return activeOverlays.find(o => o.overlayId === selectedOverlayId) || null;
  }, [selectedOverlayId, activeOverlays]);

  const selectedOverlayAssetType = useMemo((): AssetType => {
    if (!selectedOverlay || !project) return 'image';
    return project.assetIndex.byUuid.get(selectedOverlay.assetUuid)?.type ?? 'image';
  }, [selectedOverlay, project]);

  // 透明度変更（スライダー解放時: Undo スタックに乗る）
  const handleOpacityCommit = useCallback((opacity: number) => {
    if (!selectedOverlay) return;
    const event: OverlayStyleEvent = {
      type: 'OS',
      timestamp: getTimestamp(),
      sessionId,
      targets: [{ overlayId: selectedOverlay.overlayId, opacity }],
    };
    styleOverlayEvent(event, [
      { overlayId: selectedOverlay.overlayId, before: { opacity: selectedOverlay.opacity } },
    ]);
    setOverlayOpacityOverrides(new Map());
  }, [selectedOverlay, sessionId, styleOverlayEvent]);

  // zIndex 変更ヘルパー（単一ターゲット）
  const changeZIndex = useCallback((newZIndex: number) => {
    if (!selectedOverlay) return;
    const event: OverlayStyleEvent = {
      type: 'OS',
      timestamp: getTimestamp(),
      sessionId,
      targets: [{ overlayId: selectedOverlay.overlayId, zIndex: newZIndex }],
    };
    styleOverlayEvent(event, [
      { overlayId: selectedOverlay.overlayId, before: { zIndex: selectedOverlay.zIndex } },
    ]);
  }, [selectedOverlay, sessionId, styleOverlayEvent]);

  // z-order: sortedOverlays は zIndex 昇順（getActiveOverlays と同じ順序）
  const sortedOverlays = useMemo(
    () => [...activeOverlays].sort((a, b) => a.zIndex - b.zIndex),
    [activeOverlays]
  );

  const handleBringToFront = useCallback(() => {
    const maxZ = Math.max(...activeOverlays.map(o => o.zIndex));
    if (selectedOverlay && selectedOverlay.zIndex < maxZ) changeZIndex(maxZ + 1);
  }, [activeOverlays, selectedOverlay, changeZIndex]);

  const handleBringForward = useCallback(() => {
    if (!selectedOverlay) return;
    const idx = sortedOverlays.findIndex((o: OverlayState) => o.overlayId === selectedOverlay.overlayId);
    const above = sortedOverlays[idx + 1];
    // 1本の OS イベントで swap（仕様 §5-2）
    const event: OverlayStyleEvent = {
      type: 'OS',
      timestamp: getTimestamp(),
      sessionId,
      targets: [
        { overlayId: selectedOverlay.overlayId, zIndex: above.zIndex },
        { overlayId: above.overlayId,            zIndex: selectedOverlay.zIndex },
      ],
    };
    styleOverlayEvent(event, [
      { overlayId: selectedOverlay.overlayId, before: { zIndex: selectedOverlay.zIndex } },
      { overlayId: above.overlayId,            before: { zIndex: above.zIndex } },
    ]);
  }, [selectedOverlay, sortedOverlays, sessionId, styleOverlayEvent]);

  const handleSendBackward = useCallback(() => {
    if (!selectedOverlay) return;
    const idx = sortedOverlays.findIndex((o: OverlayState) => o.overlayId === selectedOverlay.overlayId);
    if (idx <= 0) return;
    const below = sortedOverlays[idx - 1];
    const event: OverlayStyleEvent = {
      type: 'OS',
      timestamp: getTimestamp(),
      sessionId,
      targets: [
        { overlayId: selectedOverlay.overlayId, zIndex: below.zIndex },
        { overlayId: below.overlayId,            zIndex: selectedOverlay.zIndex },
      ],
    };
    styleOverlayEvent(event, [
      { overlayId: selectedOverlay.overlayId, before: { zIndex: selectedOverlay.zIndex } },
      { overlayId: below.overlayId,            before: { zIndex: below.zIndex } },
    ]);
  }, [selectedOverlay, sortedOverlays, sessionId, styleOverlayEvent]);

  const handleSendToBack = useCallback(() => {
    const minZ = Math.min(...activeOverlays.map(o => o.zIndex));
    if (selectedOverlay && selectedOverlay.zIndex > minZ) changeZIndex(minZ - 1);
  }, [activeOverlays, selectedOverlay, changeZIndex]);

  // PDF ページ変更（インラインコントロールから）
  const handleInlinePageChange = useCallback((page: number) => {
    if (!selectedOverlay) return;
    const event: OverlayViewportEvent = {
      type: 'OV',
      timestamp: getTimestamp(),
      sessionId,
      overlayId: selectedOverlay.overlayId,
      viewport: selectedOverlay.viewport,
      page,
    };
    viewportOverlayEvent(event, {
      viewport: selectedOverlay.viewport,
      page: selectedOverlay.page,
    });
  }, [selectedOverlay, sessionId, viewportOverlayEvent]);

  // インラインコントロールから削除
  const handleInlineDelete = useCallback(() => {
    if (!selectedOverlayId) return;
    const overlay = activeOverlays.find(o => o.overlayId === selectedOverlayId);
    if (!overlay) return;
    const removeEvent: OverlayRemoveEvent = {
      type: 'OR',
      timestamp: getTimestamp(),
      sessionId,
      removeId: `r:${Date.now().toString(36)}`,
      targetOverlayIds: [selectedOverlayId],
    };
    const targetOverlays: OverlayAddEvent[] = [{
      type: 'OA',
      timestamp: '',
      sessionId: '',
      overlayId: overlay.overlayId,
      assetUuid: overlay.assetUuid,
      x: overlay.x, y: overlay.y,
      width: overlay.width, height: overlay.height,
      rotation: overlay.rotation,
      viewport: overlay.viewport,
      page: overlay.page,
      zIndex: overlay.zIndex,
      opacity: overlay.opacity,
    }];
    removeOverlayEvent(removeEvent, targetOverlays);
    setSelectedOverlayId(null);
    if (localBoardUuid) onAssetRemovedFromBoard(localBoardUuid, overlay.assetUuid);
  }, [selectedOverlayId, activeOverlays, sessionId, removeOverlayEvent, localBoardUuid, onAssetRemovedFromBoard]);

  // overlayId → AssetType のマップ（WhiteboardCanvas に渡して描画時に viewport source rect を使うか判定）
  const overlayAssetTypes = useMemo(() => {
    const map = new Map<string, AssetType>();
    for (const overlay of activeOverlays) {
      const asset = project?.assetIndex.byUuid.get(overlay.assetUuid);
      map.set(overlay.overlayId, asset?.type ?? 'image');
    }
    return map;
  }, [activeOverlays, project]);

  const viewportEditorAssetType = useMemo((): AssetType => {
    if (!viewportEditorOverlay || !project) return 'image';
    const asset = project.assetIndex.byUuid.get(viewportEditorOverlay.assetUuid);
    return asset?.type || 'image';
  }, [viewportEditorOverlay, project]);

  const viewportEditorAssetName = useMemo(() => {
    if (!viewportEditorOverlay || !project) return '';
    const asset = project.assetIndex.byUuid.get(viewportEditorOverlay.assetUuid);
    if (!asset) return '';
    
    // ボードの場合
    if (asset.type === 'board') {
      const match = asset.relativePath.match(/^boards\/([^/]+)\.wbelx$/);
      if (match) {
        const boardInfo = project.config.boards.get(match[1]);
        return boardInfo?.name || match[1];
      }
    }
    
    // 画像・PDF の場合
    const assetInfo = project.config.assets.get(asset.uuid);
    return assetInfo?.originalPath || asset.relativePath;
  }, [viewportEditorOverlay, project]);

  // 利用可能なアセット（画像・PDF + 他のボード）
  const availableAssets = useMemo(() => {
    const assets: Array<{ uuid: string; fileName: string; type: 'image' | 'document' | 'board' }> = [];
    
    // 画像とPDF
    for (const a of getAssets()) {
      assets.push({
        uuid: a.uuid,
        fileName: a.fileName,
        type: a.type,
      });
    }
    
    // 他のボード（循環参照チェック付き）
    if (project && localBoardUuid) {
      const boards = getBoards();
      for (const board of boards) {
        // 自分自身はスキップ
        if (board.id === boardId) continue;
        
        // このボードの UUID を取得
        const boardAssetUuid = getBoardUuid(board.id);
        if (!boardAssetUuid) continue;
        
        // 循環参照チェック
        const boardAsset = project.assetIndex.byUuid.get(boardAssetUuid);
        if (boardAsset && canAddAsOverlay(localBoardUuid, boardAsset, project.assetIndex)) {
          assets.push({
            uuid: boardAssetUuid,
            fileName: board.name,
            type: 'board',
          });
        }
      }
    }
    
    return assets;
  }, [getAssets, getBoards, getBoardUuid, project, boardId, localBoardUuid]);

  // ========================================
  // 2. イベント変更時：IndexedDB に即時保存
  // ========================================
  useEffect(() => {
    if (!isHost || !boardId) return;
    if (events.length === 0) return;
    if (events.length === lastSavedEventCountRef.current) return;

    const save = async () => {
      await saveBoardEvents(boardId, events);
      lastSavedEventCountRef.current = events.length;
    };

    save();
  }, [isHost, boardId, events]);

  // ========================================
  // 3. 戻るボタン：S イベント + スナップショット保存
  // ========================================
  const handleBack = useCallback(async () => {
    if (isHost && boardId && events.length > 0) {
      
      // S イベントを追加
      const snapshotMarker: SnapshotMarkerEvent = {
        type: 'S',
        timestamp: getTimestamp(),
        sessionId,
        snapshotHash: generateSnapshotId(),
      };
      const eventsWithS = [...events, snapshotMarker];
      
      // イベントログを保存
      await saveBoardEvents(boardId, eventsWithS);
      
      // スナップショットを保存（ストローク + オーバーレイ）
      const snapshotEvents: WbelxEvent[] = [
        ...activeStrokes,
        ...activeOverlays.map(overlay => ({
          type: 'OA' as const,
          timestamp: getTimestamp(),
          sessionId,
          overlayId: overlay.overlayId,
          assetUuid: overlay.assetUuid,
          x: overlay.x,
          y: overlay.y,
          width: overlay.width,
          height: overlay.height,
          rotation: overlay.rotation,
          viewport: overlay.viewport,
          page: overlay.page,
          zIndex: overlay.zIndex,
          opacity: overlay.opacity,
        })),
      ];
      await saveBoardSnapshot(boardId, snapshotEvents);
      
      // サムネイル再生成（非同期、エラーは無視）
      try { await regenerateThumbnail(boardId); } catch { /* ignore */ }
    }
    
    navigate(isJoiningViaShareLink ? '/' : '/project');
  }, [isHost, boardId, events, sessionId, activeStrokes, activeOverlays, navigate, isJoiningViaShareLink, regenerateThumbnail]);

  // ゲストがいる場合はスナップショットをクリア
  useEffect(() => {
    if (isHost && boardId && guestsPresent) {
      deleteBoardSnapshot(boardId);
    }
  }, [isHost, boardId, guestsPresent]);

  // 共有リンクをコピー
  const handleCopyShareLink = useCallback(() => {
    const baseUrl = `${window.location.origin}${window.location.pathname}`;
    const shareUrl = `${baseUrl}?room=${encodeURIComponent(roomId)}`;
    navigator.clipboard.writeText(shareUrl).catch(() => {
      prompt('Share this link:', shareUrl);
    });
  }, [roomId]);

  // エクスポート
  const handleExportWbelx = useCallback(() => {
    const content = exportWbelx();
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${boardInfo?.name || 'board'}.wbelx`;
    a.click();
    URL.revokeObjectURL(url);
  }, [exportWbelx, boardInfo]);

  const handleExportSnapshot = useCallback(() => {
    const content = exportSnapshotWbelx();
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${boardInfo?.name || 'board'}.snap.wbelx`;
    a.click();
    URL.revokeObjectURL(url);
  }, [exportSnapshotWbelx, boardInfo]);

  // キーボードショートカット
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        e.shiftKey ? performRedo() : performUndo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        e.preventDefault();
        performRedo();
        return;
      }

      switch (e.key.toLowerCase()) {
        case 'v': setTool('select'); break;
        case 'p': setTool('pen'); break;
        case 'e': setTool('eraser'); break;
        case ' ': e.preventDefault(); setTool('pan'); break;
        case '1': setStrokeWidthKey('thin'); break;
        case '2': setStrokeWidthKey('medium'); break;
        case '3': setStrokeWidthKey('thick'); break;
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') setTool('pen');
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [performUndo, performRedo]);

  // ========================================
  // レンダリング
  // ========================================

  // ローディング
  if (isLoading) {
    return (
      <div className="loading-page">
        <div className="loading-spinner" />
        <p className="loading-message">ボードを読み込み中...</p>
      </div>
    );
  }

  // エラー
  if (loadError) {
    return (
      <div className="error-page">
        <div className="error-icon">⚠️</div>
        <h1 className="error-title">読み込みエラー</h1>
        <p className="error-message">{loadError}</p>
        <button className="error-btn primary" onClick={() => navigate('/')}>ホームに戻る</button>
      </div>
    );
  }

  // 共有リンクでタイムアウト
  if (isJoiningViaShareLink && peerSearchTimedOut && !hasSyncedData) {
    return (
      <div className="error-page">
        <div className="error-icon">🔍</div>
        <h1 className="error-title">ホワイトボードが見つかりません</h1>
        <p className="error-message">共有リンクが無効か、ホストが退出している可能性があります。</p>
        <button className="error-btn primary" onClick={() => navigate('/')}>ホームに戻る</button>
      </div>
    );
  }

  // 共有リンクで接続中
  if (isJoiningViaShareLink && isJoiningRoom) {
    return (
      <div className="loading-page">
        <div className="loading-spinner" />
        <p className="loading-message">接続中...</p>
      </div>
    );
  }

  // プロジェクトなし
  if (!project && !isJoiningViaShareLink) {
    navigate('/');
    return null;
  }

  // ボードなし
  if (!isJoiningViaShareLink && (!boardId || !boardInfo)) {
    navigate('/project');
    return null;
  }

  if (!roomId) {
    navigate('/');
    return null;
  }

  // ホストが準備中（P2P接続確立 + ゲスト検出/データロード中）
  const isHostPreparing = isHost && isJoiningRoom;

  return (
    <div className="editor">
      {/* 通知 */}
      {notifications.length > 0 && (
        <div className="notifications">
          {notifications.map((n: Notification) => (
            <div key={n.id} className={`notification ${n.type}`}>
              {n.type === 'join' ? '👋' : '👤'} {n.name} が
              {n.type === 'join' ? '参加しました' : '退出しました'}
            </div>
          ))}
        </div>
      )}
      
      {/* ホスト準備中オーバーレイ */}
      {isHostPreparing && (
        <div className="preparing-overlay">
          <div className="preparing-content">
            <div className="loading-spinner" />
            <p className="preparing-message">セッションを準備中...</p>
            <p className="preparing-detail">
              {peerCount > 0 
                ? `${peerCount}人のゲストと同期中` 
                : 'ピアを検索中'}
            </p>
          </div>
        </div>
      )}
      
      {!isHost && !isHostConnected && (
        <div className="host-disconnected-banner">
          <span className="banner-icon">⚠️</span>
          <span className="banner-text">
            ホストとの接続が切れています。編集内容は保存されない可能性があります。
          </span>
        </div>
      )}
      
      <Toolbar
        boardName={boardInfo?.name || 'Shared Board'}
        tool={tool}
        color={color}
        strokeWidthKey={strokeWidthKey}
        canUndo={canUndo}
        canRedo={canRedo}
        isConnected={isConnected}
        peerCount={peerCount}
        hasContent={hasContent}
        onBack={handleBack}
        onToolChange={setTool}
        onColorChange={setColor}
        onStrokeWidthChange={setStrokeWidthKey}
        onUndo={performUndo}
        onRedo={performRedo}
        onCopyShareLink={handleCopyShareLink}
        onExportWbelx={handleExportWbelx}
        onExportSnapshot={handleExportSnapshot}
        onAddAsset={handleAddAsset}
        onImportFile={importAsset}
        availableAssets={availableAssets}
        canvasSize={canvasSize}
        onCanvasSizeChange={isHost && boardId ? (w, h) => setBoardCanvasSize(boardId, w, h) : undefined}
      />
      <main className={`canvas-container ${isHostPreparing ? 'preparing' : ''}`} style={{ position: 'relative' }}>
        <WhiteboardCanvas
          activeStrokes={activeStrokes}
          activeOverlays={activeOverlays}
          cursors={cursors}
          tool={tool}
          color={color}
          strokeWidth={STROKE_WIDTHS[strokeWidthKey as StrokeWidthKey]}
          sessionId={sessionId}
          selectedOverlayId={selectedOverlayId}
          overlayImages={overlayImages}
          overlayAssetTypes={overlayAssetTypes}
          overlayOpacityOverrides={overlayOpacityOverrides}
          overlayLockAspectRatios={overlayLockAspectRatios}
          loadingOverlayIds={loadingOverlayIds}
          missingOverlayIds={missingOverlayIds}
          backgroundConfig={project?.config.background}
          canvasSize={canvasSize}
          onAddDrawEvent={addDrawEvent}
          onAddEraseEvent={addEraseEvent}
          onRemoveOverlayEvent={handleRemoveOverlay}
          onTransformOverlay={transformOverlayEvent}
          onSelectOverlay={setSelectedOverlayId}
          onDoubleClickOverlay={(overlayId) => setViewportEditorOverlayId(overlayId)}
          onUpdateCursor={updateCursor}
          onHideCursor={hideCursor}
          onTransformChange={handleTransformChange}
        />

        {/* オーバーレイ選択中: インラインコントロール */}
        {selectedOverlay && tool === 'select' && (() => {
          const selIdx = sortedOverlays.findIndex((o: OverlayState) => o.overlayId === selectedOverlay.overlayId);
          const canBringForward = selIdx < sortedOverlays.length - 1;
          const canSendBackward = selIdx > 0;
          return (
            <OverlayInlineControls
              overlay={selectedOverlay}
              assetType={selectedOverlayAssetType}
              canvasTransform={canvasTransformFull}
              pdfTotalPages={pdfPageCounts.get(selectedOverlay.assetUuid) ?? 1}
              canBringForward={canBringForward}
              canSendBackward={canSendBackward}
              onBringToFront={handleBringToFront}
              onBringForward={handleBringForward}
              onSendBackward={handleSendBackward}
              onSendToBack={handleSendToBack}
              onPageChange={handleInlinePageChange}
              onOpacityPreview={(opacity) => {
                setOverlayOpacityOverrides(new Map([[selectedOverlay.overlayId, opacity]]));
              }}
              onOpacityCommit={handleOpacityCommit}
              onOpenViewportEditor={() => setViewportEditorOverlayId(selectedOverlayId!)}
              onDelete={handleInlineDelete}
            />
          );
        })()}
      </main>
      
      {/* ViewportEditor モーダル */}
      {viewportEditorOverlay && (
        <ViewportEditor
          overlay={viewportEditorOverlay}
          assetType={viewportEditorAssetType}
          assetUuid={viewportEditorOverlay.assetUuid}
          assetName={viewportEditorAssetName}
          availableAssets={availableAssets}
          lockAspectRatio={overlayLockAspectRatios.get(viewportEditorOverlay.overlayId) ?? true}
          onApply={handleApplyViewport}
          onClose={handleCloseViewportEditor}
          onUploadFile={importAsset}
        />
      )}
    </div>
  );
}
