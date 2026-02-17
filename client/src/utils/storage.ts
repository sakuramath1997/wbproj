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
  CollaborationConfig,
  ImportedAssetInfo,
} from '../types/project';
import { DEFAULT_BACKGROUND, DEFAULT_COLLABORATION } from '../types/project';

// ========================================
// キー生成
// ========================================

const KEYS = {
  projectConfig: () => 'project:config',
  assetIndex: () => 'project:assetIndex',
  assetFile: (uuid: string) => `asset:${uuid}:file`,
  boardEvents: (boardId: string) => `board:${boardId}:events`,
  boardSnapshot: (boardId: string) => `board:${boardId}:snapshot`,
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
    createdAt: string;
    updatedAt: string;
  };
  background: BackgroundConfig;
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
    mimeType: string;
    fileSize: number;
  }>;
}

/** ProjectConfig を保存 */
export async function saveProjectConfig(config: ProjectConfig): Promise<void> {
  const serialized: SerializedProjectConfig = {
    project: config.project,
    background: config.background,
    collaboration: config.collaboration,
    boards: Array.from(config.boards.values()).map(info => ({
      id: info.id,
      name: info.name,
      createdAt: info.createdAt,
      updatedAt: info.updatedAt,
      displayOrder: info.displayOrder,
      hostedBy: info.hostedBy,
      hostedSince: info.hostedSince,
    })),
    assets: Array.from(config.assets.values()),
  };
  await set(KEYS.projectConfig(), serialized);
}

/** ProjectConfig を読み込み */
export async function loadProjectConfig(): Promise<ProjectConfig | null> {
  const serialized = await get<SerializedProjectConfig>(KEYS.projectConfig());
  if (!serialized) return null;
  
  const boards = new Map(
    serialized.boards.map(b => [b.id, {
      id: b.id,
      name: b.name,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
      displayOrder: b.displayOrder,
      hostedBy: b.hostedBy,
      hostedSince: b.hostedSince,
    }])
  );
  
  const assets = new Map<string, ImportedAssetInfo>(
    (serialized.assets || []).map(a => [a.uuid, a])
  );
  
  return {
    project: serialized.project,
    background: serialized.background || DEFAULT_BACKGROUND,
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
