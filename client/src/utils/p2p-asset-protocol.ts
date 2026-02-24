/**
 * P2P アセット転送プロトコル
 *
 * y-webrtc の Data Channel 上にカスタムメッセージを載せる。
 * y-webrtc のメッセージタイプ (0-4) と衝突しない 100 番台を使用。
 *
 * メッセージ形式:
 *   [1 byte: msgType][payload]
 *
 *   JSON 系 (100,101,103,104,105): payload = UTF-8 JSON
 *   バイナリ系 (102):
 *     [1 byte: 102][36 bytes: uuid ASCII][4 bytes: chunkIndex BE uint32][data]
 */

// ========================================
// メッセージタイプ
// ========================================

export const MSG = {
  /** ゲスト→ホスト: アセットリクエスト */
  ASSET_REQUEST:       100,
  /** ホスト→ゲスト: アセットメタデータ（転送開始通知） */
  ASSET_META:          101,
  /** ホスト→ゲスト: アセットチャンク（バイナリ） */
  ASSET_CHUNK:         102,
  /** ホスト→ゲスト: 転送完了 */
  ASSET_COMPLETE:      103,
  /** ゲスト→ホスト: プロジェクトメタデータ要求 */
  PROJECT_META_REQ:    104,
  /** ホスト→ゲスト: プロジェクトメタデータ応答 */
  PROJECT_META_RES:    105,
  /** ホスト→ゲスト: アセットが見つからない */
  ASSET_NOT_FOUND:     106,
} as const;

export type MsgType = (typeof MSG)[keyof typeof MSG];

// ========================================
// ペイロード型
// ========================================

export interface AssetRequestPayload {
  uuid: string;
}

export interface AssetMetaPayload {
  uuid: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  totalChunks: number;
}

export interface AssetChunkHeader {
  uuid: string;
  chunkIndex: number;
}

export interface AssetCompletePayload {
  uuid: string;
}

export interface AssetNotFoundPayload {
  uuid: string;
}

export interface ProjectMetaPayload {
  assets: Array<{
    uuid: string;
    type: string;
    originalName: string;
    mimeType: string;
    fileSize: number;
    relativePath: string;
    referencedBy: string[];
    allAncestors: string[];
  }>;
}

// ========================================
// 定数
// ========================================

/** チャンクサイズ (16 KB) — WebRTC Data Channel で安全な範囲 */
export const CHUNK_SIZE = 16 * 1024;

/** UUID ASCII 固定長 (36 文字: 8-4-4-4-12) */
const UUID_LEN = 36;

// ========================================
// エンコード / デコード
// ========================================

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** JSON メッセージをエンコード */
export function encodeJsonMsg(type: MsgType, payload: unknown): Uint8Array {
  const json = encoder.encode(JSON.stringify(payload));
  const buf = new Uint8Array(1 + json.length);
  buf[0] = type;
  buf.set(json, 1);
  return buf;
}

/** バイナリチャンクメッセージをエンコード (type=102) */
export function encodeChunkMsg(uuid: string, chunkIndex: number, data: Uint8Array): Uint8Array {
  // [1: type][36: uuid][4: chunkIndex BE][data]
  const buf = new Uint8Array(1 + UUID_LEN + 4 + data.length);
  buf[0] = MSG.ASSET_CHUNK;
  // UUID を ASCII で書き込み（36 文字固定）
  for (let i = 0; i < UUID_LEN; i++) {
    buf[1 + i] = i < uuid.length ? uuid.charCodeAt(i) : 0x20; // space padding
  }
  // chunkIndex を big-endian uint32 で書き込み
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  view.setUint32(1 + UUID_LEN, chunkIndex, false);
  // データ本体
  buf.set(data, 1 + UUID_LEN + 4);
  return buf;
}

/** メッセージタイプを読み取る（先頭 1 バイト） */
export function readMsgType(data: Uint8Array): number {
  return data[0];
}

/** JSON ペイロードをデコード */
export function decodeJsonPayload<T>(data: Uint8Array): T {
  return JSON.parse(decoder.decode(data.subarray(1)));
}

/** チャンクメッセージをデコード */
export function decodeChunkMsg(data: Uint8Array): { uuid: string; chunkIndex: number; chunk: Uint8Array } {
  const uuid = decoder.decode(data.subarray(1, 1 + UUID_LEN)).trim();
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const chunkIndex = view.getUint32(1 + UUID_LEN, false);
  const chunk = data.subarray(1 + UUID_LEN + 4);
  return { uuid, chunkIndex, chunk };
}

/** カスタムメッセージかどうか判定（type >= 100） */
export function isCustomMsg(data: Uint8Array | ArrayBuffer): boolean {
  const arr = data instanceof Uint8Array ? data : new Uint8Array(data);
  return arr.length > 0 && arr[0] >= 100;
}

// ========================================
// ArrayBuffer ↔ チャンク分割 / 結合
// ========================================

/** ArrayBuffer をチャンク分割 */
export function splitIntoChunks(data: ArrayBuffer): Uint8Array[] {
  const src = new Uint8Array(data);
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < src.length; offset += CHUNK_SIZE) {
    chunks.push(src.subarray(offset, Math.min(offset + CHUNK_SIZE, src.length)));
  }
  // 空データの場合は空チャンク 1 個
  if (chunks.length === 0) chunks.push(new Uint8Array(0));
  return chunks;
}

/** チャンク群を結合して ArrayBuffer に戻す */
export function mergeChunks(chunks: Map<number, Uint8Array>, totalChunks: number): ArrayBuffer {
  let totalLen = 0;
  for (let i = 0; i < totalChunks; i++) {
    const c = chunks.get(i);
    if (c) totalLen += c.length;
  }
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (let i = 0; i < totalChunks; i++) {
    const c = chunks.get(i);
    if (c) {
      result.set(c, offset);
      offset += c.length;
    }
  }
  return result.buffer;
}

// ========================================
// 受信バッファ（ゲスト側）
// ========================================

export interface IncomingTransfer {
  uuid: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  totalChunks: number;
  receivedChunks: Map<number, Uint8Array>;
  receivedBytes: number;
}

/** 受信バッファを作成 */
export function createIncomingTransfer(meta: AssetMetaPayload): IncomingTransfer {
  return {
    uuid: meta.uuid,
    fileName: meta.fileName,
    mimeType: meta.mimeType,
    fileSize: meta.fileSize,
    totalChunks: meta.totalChunks,
    receivedChunks: new Map(),
    receivedBytes: 0,
  };
}

/** チャンクを追加。完了したら true を返す */
export function addChunk(transfer: IncomingTransfer, chunkIndex: number, chunk: Uint8Array): boolean {
  if (transfer.receivedChunks.has(chunkIndex)) return false; // 重複
  transfer.receivedChunks.set(chunkIndex, chunk);
  transfer.receivedBytes += chunk.length;
  return transfer.receivedChunks.size >= transfer.totalChunks;
}

/** 転送の進捗率 (0.0 - 1.0) */
export function transferProgress(transfer: IncomingTransfer): number {
  if (transfer.totalChunks === 0) return 1;
  return transfer.receivedChunks.size / transfer.totalChunks;
}
