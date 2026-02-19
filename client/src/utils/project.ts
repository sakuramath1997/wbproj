/**
 * プロジェクト管理ユーティリティ
 * 
 * .wbproj の読み書き、プロジェクト操作
 */

import type {
  ProjectConfig,
  WbAsset,
  AssetIndex,
  WbelxEvent,
} from '../types';
import {
  createProjectConfig,
  createBoardInfo,
  projectConfigToToml,
  createAssetIndex,
  addToAssetIndex,
  wbassetToToml,
} from '../types';
import { parseProjectToml, parseWbasset } from './toml-parser';
import { parseWbelx, eventsToWbelx, createSnapshot, parseSnapshot } from './wbelx-parser';
import { generateUuid, getNextBoardId } from './common';

// ========================================
// プロジェクト構造（メモリ上）
// ========================================

export interface Project {
  config: ProjectConfig;
  assetIndex: AssetIndex;
  boards: Map<string, WbelxEvent[]>;  // id → events
  /** uuid → { data, mimeType } のアセットバイナリ（画像・PDF等） */
  assetFiles: Map<string, { data: ArrayBuffer; mimeType: string; fileName: string }>;
  /** id → snapshot events（ZIP からの読み込み / ZIP への書き出し用） */
  snapshots: Map<string, WbelxEvent[]>;
  /** id → PNG Blob（サムネイル。ZIP 出力・UI 表示用） */
  thumbnails: Map<string, Blob>;
}

// ========================================
// 新規プロジェクト作成
// ========================================

/**
 * 新規プロジェクトを作成
 */
export function createNewProject(name: string): Project {
  const config = createProjectConfig(name);
  const assetIndex = createAssetIndex();

  // 初期ボードを作成
  const boardId = '0001';
  const boardUuid = generateUuid();

  // ボード情報を追加
  config.boards.set(boardId, createBoardInfo(boardId, 'Board 1', 1));

  // wbasset を作成
  const boardAsset: WbAsset = {
    uuid: boardUuid,
    type: 'board',
    relativePath: `boards/${boardId}.wbelx`,
    referencedBy: [],
    allAncestors: [],
  };
  addToAssetIndex(assetIndex, boardAsset);

  return {
    config,
    assetIndex,
    boards: new Map([[boardId, []]]),
    assetFiles: new Map(),
    snapshots: new Map(),
    thumbnails: new Map(),
  };
}

// ========================================
// ボード操作
// ========================================

/**
 * ボードを追加
 */
export function addBoard(project: Project, name: string): string {
  const existingIds = Array.from(project.config.boards.keys());
  const newId = getNextBoardId(existingIds);
  const displayOrder = project.config.boards.size + 1;

  // ボード情報を追加
  project.config.boards.set(newId, createBoardInfo(newId, name, displayOrder));

  // wbasset を作成
  const boardUuid = generateUuid();
  const boardAsset: WbAsset = {
    uuid: boardUuid,
    type: 'board',
    relativePath: `boards/${newId}.wbelx`,
    referencedBy: [],
    allAncestors: [],
  };
  addToAssetIndex(project.assetIndex, boardAsset);

  // 空のイベントリストを作成
  project.boards.set(newId, []);

  return newId;
}

/**
 * ボードの UUID を取得
 */
export function getBoardUuid(project: Project, boardId: string): string | undefined {
  const path = `boards/${boardId}.wbelx`;
  return project.assetIndex.byPath.get(path)?.uuid;
}

/**
 * UUID からボード ID を取得
 */
export function getBoardIdFromUuid(project: Project, uuid: string): string | undefined {
  const asset = project.assetIndex.byUuid.get(uuid);
  if (!asset || asset.type !== 'board') return undefined;

  // relativePath から ID を抽出: "boards/0001.wbelx" → "0001"
  const match = asset.relativePath.match(/^boards\/(\d+)\.wbelx$/);
  return match?.[1];
}

// ========================================
// ZIP 読み書き（JSZip 使用）
// ========================================

// JSZip は動的インポートで使用（バンドルサイズ考慮）

/**
 * .wbproj ファイルを読み込み
 */
export async function loadProject(file: File): Promise<Project> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(file);

  // project.toml を読み込み
  const projectTomlFile = zip.file('project.toml');
  if (!projectTomlFile) {
    throw new Error('project.toml not found');
  }
  const projectTomlContent = await projectTomlFile.async('text');
  const config = parseProjectToml(projectTomlContent);

  // wbasset を読み込み
  const assetIndex = createAssetIndex();
  const wbassetFiles = zip.folder('wbasset')?.file(/\.wbasset$/);
  if (wbassetFiles) {
    for (const file of wbassetFiles) {
      const content = await file.async('text');
      const asset = parseWbasset(content);
      if (asset) {
        addToAssetIndex(assetIndex, asset);
      }
    }
  }

  // ボードを読み込み
  const boards = new Map<string, WbelxEvent[]>();
  for (const [id] of config.boards) {
    const boardFile = zip.file(`boards/${id}.wbelx`);
    if (boardFile) {
      const content = await boardFile.async('text');
      const events = parseWbelx(content);
      boards.set(id, events);
    } else {
      boards.set(id, []);
    }
  }

  // アセットファイル（画像・PDF等）を読み込み
  const assetFiles = new Map<string, { data: ArrayBuffer; mimeType: string; fileName: string }>();
  for (const [uuid, assetInfo] of config.assets) {
    const asset = assetIndex.byUuid.get(uuid);
    const relativePath = asset?.relativePath || `assets/${uuid}`;
    const assetFile = zip.file(relativePath);
    if (assetFile) {
      const data = await assetFile.async('arraybuffer');
      assetFiles.set(uuid, {
        data,
        mimeType: assetInfo.mimeType,
        fileName: assetFile.name.split('/').pop() || uuid,
      });
    }
  }

  // スナップショットを読み込み
  const snapshots = new Map<string, WbelxEvent[]>();
  for (const [id] of config.boards) {
    const snapshotFile = zip.file(`boards/${id}.snapshot.wbelx`);
    if (snapshotFile) {
      const content = await snapshotFile.async('text');
      const result = parseSnapshot(content);
      if (result) {
        snapshots.set(id, result.events);
      }
    }
  }

  // サムネイルを読み込み
  const thumbnails = new Map<string, Blob>();
  for (const [id] of config.boards) {
    const thumbFile = zip.file(`thumbnails/${id}.png`);
    if (thumbFile) {
      const data = await thumbFile.async('arraybuffer');
      thumbnails.set(id, new Blob([data], { type: 'image/png' }));
    }
  }

  return { config, assetIndex, boards, assetFiles, snapshots, thumbnails };
}

/**
 * .wbproj ファイルとして保存
 */
export async function saveProject(project: Project): Promise<Blob> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();

  // project.toml
  project.config.project.updatedAt = new Date().toISOString();
  zip.file('project.toml', projectConfigToToml(project.config));

  // boards/
  const boardsFolder = zip.folder('boards');
  for (const [id, events] of project.boards) {
    boardsFolder?.file(`${id}.wbelx`, eventsToWbelx(events));
  }

  // wbasset/
  const wbassetFolder = zip.folder('wbasset');
  for (const [uuid, asset] of project.assetIndex.byUuid) {
    wbassetFolder?.file(`${uuid}.wbasset`, wbassetToToml(asset));
  }

  // assets/ バイナリ
  if (project.assetFiles.size > 0) {
    const assetsFolder = zip.folder('assets');
    for (const [uuid, file] of project.assetFiles) {
      const asset = project.assetIndex.byUuid.get(uuid);
      if (asset && asset.type !== 'board') {
        // relative_path から assets/ 以降のファイル名を取得
        const fileName = asset.relativePath.replace(/^assets\//, '');
        assetsFolder?.file(fileName, file.data);
      }
    }
  }

  // snapshots/
  for (const [id, snapshotEvents] of project.snapshots) {
    if (snapshotEvents.length > 0) {
      const hash = `sha256:export-${Date.now().toString(36)}`;
      boardsFolder?.file(`${id}.snapshot.wbelx`, createSnapshot(snapshotEvents, hash));
    }
  }

  // thumbnails/
  if (project.thumbnails.size > 0) {
    const thumbsFolder = zip.folder('thumbnails');
    for (const [id, blob] of project.thumbnails) {
      thumbsFolder?.file(`${id}.png`, blob);
    }
  }

  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}

/**
 * 単一の .wbel/.wbelx/.snapshot.wbelx ファイルをプロジェクトとして読み込み。
 * SS ヘッダー付きスナップショットも同一パーサーで処理する。
 */
export async function loadSingleBoard(file: File): Promise<Project> {
  const content = await file.text();
  // parseWbelx は H/SS ヘッダーを自動スキップするので、通常ファイル・スナップショットどちらでもOK
  const events = parseWbelx(content);

  // ファイル名からプロジェクト名を生成
  const name = file.name
    .replace(/\.snapshot\.wbelx$/, '')
    .replace(/\.(wbelx?|wbel)$/, '');

  const project = createNewProject(name);
  project.boards.set('0001', events);

  return project;
}
