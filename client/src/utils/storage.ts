/**
 * IndexedDB 永続化ユーティリティ
 * 
 * ボードデータを IndexedDB に保存・読み込み
 */

import { get, set, del, keys } from 'idb-keyval';
import type { WbelxEvent, WbAsset, AssetIndex } from '../types';
import { createAssetIndex, addToAssetIndex } from '../types';
import type { 
  ProjectConfig, 
  BackgroundConfig, 
  RenderingConfig,
  CollaborationConfig,
  BoardInfo,
  ImportedAssetInfo,
} from '../types/project';
import { DEFAULT_BACKGROUND, DEFAULT_RENDERING, DEFAULT_COLLABORATION } from '../types/project';

// ========================================
// キー生成
// ========================================

const KEYS = {
  projectConfig: () => 'project:config',
  assetIndex: () => 'project:assetIndex',
  assetFile: (uuid: string) => `asset:${uuid}:file`,
  boardEvents: (boardId: string) => `board:${boardId}:events`,
  boardSnapshot: (boardId: string) => `board:${boardId}:snapshot`,
  boardThumbnail: (boardId: string) => `board:${boardId}:thumbnail`,
  boardUuids: () => 'project:boardUuids',
};

// ========================================
// プロジェクト設定
// ========================================

/** プロジェクト設定の保存形式（Map → Object 変換） */
interface SerializedProjectConfig {
  project: {
    name: string;
    version: string;
    uuid?: string;          // v4 で追加
    createdAt: string;
    updatedAt: string;
  };
  defaults?: {              // v4 で追加
    canvasWidth: number;
    canvasHeight: number;
  };
  background: BackgroundConfig;
  rendering?: RenderingConfig;
  collaboration: CollaborationConfig;
  boards: Array<{
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    displayOrder: number;
    hostedBy: string;
    hostedSince: string;
  }>;
  assets: Array<{
    uuid: string;
    originalPath: string;
    importedBy: string;
    importedAt: string;
    mimeType?: string;      // v4 で wbasset に移動（後方互換のため optional）
    fileSize?: number;      // v4 で wbasset に移動（後方互換のため optional）
  }>;
}

/** ProjectConfig を保存 */
export async function saveProjectConfig(config: ProjectConfig): Promise<void> {
  const serialized: SerializedProjectConfig = {
    project: config.project,
    defaults: config.defaults,
    background: config.background,
    rendering: config.rendering,
    collaboration: config.collaboration,
    boards: Array.from(config.boards.values()).map(info => ({
      id: info.id,
      name: info.name,
      createdAt: info.createdAt,
      updatedAt: info.updatedAt,
      displayOrder: info.displayOrder,
      hostedBy: info.hostedBy,
      hostedSince: info.hostedSince,
      ...(info.canvasWidth && info.canvasHeight ? { canvasWidth: info.canvasWidth, canvasHeight: info.canvasHeight } : {}),
    })),
    assets: Array.from(config.assets.values()),
  };
  await set(KEYS.projectConfig(), serialized);
}

/** ProjectConfig を読み込み */
export async function loadProjectConfig(): Promise<ProjectConfig | null> {
  const serialized = await get<SerializedProjectConfig>(KEYS.projectConfig());
  if (!serialized) return null;
  
  const boards = new Map<string, BoardInfo>(
    serialized.boards.map((b: BoardInfo) => [b.id, {
      id: b.id,
      name: b.name,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
      displayOrder: b.displayOrder,
      hostedBy: b.hostedBy,
      hostedSince: b.hostedSince,
      ...(b.canvasWidth && b.canvasHeight ? { canvasWidth: b.canvasWidth, canvasHeight: b.canvasHeight } : {}),
    }])
  );
  
  const assets = new Map<string, ImportedAssetInfo>(
    (serialized.assets || []).map((a: ImportedAssetInfo) => [a.uuid, a])
  );
  
  return {
    project: {
      version: String(serialized.project.version || '4.0'),
      uuid: String(serialized.project.uuid || ''),
      name: String(serialized.project.name || 'Untitled'),
      createdAt: String(serialized.project.createdAt || new Date().toISOString()),
      updatedAt: String(serialized.project.updatedAt || new Date().toISOString()),
    },
    defaults: serialized.defaults || { canvasWidth: 0, canvasHeight: 0 },
    background: serialized.background || DEFAULT_BACKGROUND,
    rendering: serialized.rendering || { ...DEFAULT_RENDERING, boardOverlayFallbackViewport: { ...DEFAULT_RENDERING.boardOverlayFallbackViewport } },
    collaboration: serialized.collaboration || DEFAULT_COLLABORATION,
    boards,
    assets,
  };
}

/** プロジェクト設定を削除 */
export async function deleteProjectConfig(): Promise<void> {
  await del(KEYS.projectConfig());
}

// ========================================
// Board UUID マッピング
// ========================================

/** boardId → UUID マッピングを保存 */
export async function saveBoardUuids(uuids: Map<string, string>): Promise<void> {
  const obj = Object.fromEntries(uuids);
  await set(KEYS.boardUuids(), obj);
}

/** boardId → UUID マッピングを読み込み */
export async function loadBoardUuids(): Promise<Map<string, string>> {
  const obj = await get<Record<string, string>>(KEYS.boardUuids());
  if (!obj) return new Map();
  return new Map(Object.entries(obj));
}

// ========================================
// AssetIndex
// ========================================

/** AssetIndex の保存形式 */
interface SerializedAssetIndex {
  assets: WbAsset[];
}

/** AssetIndex を保存 */
export async function saveAssetIndex(index: AssetIndex): Promise<void> {
  const serialized: SerializedAssetIndex = {
    assets: Array.from(index.byUuid.values()),
  };
  await set(KEYS.assetIndex(), serialized);
}

/** AssetIndex を読み込み */
export async function loadAssetIndex(): Promise<AssetIndex> {
  const serialized = await get<SerializedAssetIndex>(KEYS.assetIndex());
  const index = createAssetIndex();
  
  if (serialized?.assets) {
    for (const asset of serialized.assets) {
      addToAssetIndex(index, asset);
    }
  }
  
  return index;
}

// ========================================
// ボードイベント
// ========================================

/** ボードイベントを保存 */
export async function saveBoardEvents(boardId: string, events: WbelxEvent[]): Promise<void> {
  await set(KEYS.boardEvents(boardId), events);
}

/** ボードイベントを読み込み */
export async function loadBoardEvents(boardId: string): Promise<WbelxEvent[]> {
  const events = await get<WbelxEvent[]>(KEYS.boardEvents(boardId));
  return events || [];
}

/** ボードイベントを削除 */
export async function deleteBoardEvents(boardId: string): Promise<void> {
  await del(KEYS.boardEvents(boardId));
}

// ========================================
// スナップショット
// ========================================

/** スナップショットを保存（ストローク + オーバーレイ） */
export async function saveBoardSnapshot(boardId: string, events: WbelxEvent[]): Promise<void> {
  await set(KEYS.boardSnapshot(boardId), events);
}

/** スナップショットを読み込み */
export async function loadBoardSnapshot(boardId: string): Promise<WbelxEvent[] | null> {
  const events = await get<WbelxEvent[]>(KEYS.boardSnapshot(boardId));
  return events || null;
}

/** スナップショットを削除 */
export async function deleteBoardSnapshot(boardId: string): Promise<void> {
  await del(KEYS.boardSnapshot(boardId));
}

// ========================================
// 全データ削除
// ========================================

/** 全プロジェクトデータを削除 */
export async function clearAllData(): Promise<void> {
  const allKeys = await keys();
  for (const key of allKeys) {
    await del(key);
  }
}

// ========================================
// ボード削除
// ========================================

/** ボード関連データを全て削除 */
export async function deleteBoardData(boardId: string): Promise<void> {
  await deleteBoardEvents(boardId);
  await deleteBoardSnapshot(boardId);
  await deleteBoardThumbnail(boardId);
}

// ========================================
// アセットファイル（画像/PDF バイナリ）
// ========================================

/** アセットファイル情報 */
export interface StoredAssetFile {
  uuid: string;
  fileName: string;
  mimeType: string;
  data: ArrayBuffer;
  size: number;
}

/** アセットファイルを保存 */
export async function saveAssetFile(file: StoredAssetFile): Promise<void> {
  await set(KEYS.assetFile(file.uuid), file);
}

/** アセットファイルを読み込み */
export async function loadAssetFile(uuid: string): Promise<StoredAssetFile | null> {
  const file = await get<StoredAssetFile>(KEYS.assetFile(uuid));
  return file || null;
}

/** アセットファイルを削除 */
export async function deleteAssetFile(uuid: string): Promise<void> {
  await del(KEYS.assetFile(uuid));
}

/** アセットファイルを Blob として取得 */
export async function loadAssetFileAsBlob(uuid: string): Promise<Blob | null> {
  const file = await loadAssetFile(uuid);
  if (!file) return null;
  return new Blob([file.data], { type: file.mimeType });
}

/** アセットファイルを Data URL として取得 */
export async function loadAssetFileAsDataUrl(uuid: string): Promise<string | null> {
  const blob = await loadAssetFileAsBlob(uuid);
  if (!blob) return null;
  
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

// ========================================
// サムネイル
// ========================================

/** サムネイル PNG を保存 */
export async function saveBoardThumbnail(boardId: string, blob: Blob): Promise<void> {
  const buf = await blob.arrayBuffer();
  await set(KEYS.boardThumbnail(boardId), buf);
}

/** サムネイル PNG を取得 */
export async function loadBoardThumbnail(boardId: string): Promise<Blob | null> {
  const buf = await get<ArrayBuffer>(KEYS.boardThumbnail(boardId));
  if (!buf) return null;
  return new Blob([buf], { type: 'image/png' });
}

/** サムネイル PNG を削除 */
export async function deleteBoardThumbnail(boardId: string): Promise<void> {
  await del(KEYS.boardThumbnail(boardId));
}
