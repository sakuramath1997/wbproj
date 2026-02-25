import { create } from 'zustand';
import type { BoardInfo, WbelxEvent, SnapshotMarkerEvent, WbAsset, AssetType, DrawEvent, OverlayState, BackgroundConfig } from '../types';
import { removeFromAssetIndex, addToAssetIndex, onOverlayAdded, onOverlayRemoved, createBoardInfo } from '../types';
import type { Project } from '../utils';
import { 
  createNewProject, 
  loadProject, 
  loadSingleBoard, 
  saveProject,
  addBoard as addBoardToProject,
  getBoardUuid,
} from '../utils';
import { generateUuid } from '../utils/common';
import { computeState, getActiveStrokes, getActiveOverlays } from '../core/state-machine';
import { minimizeWbelx } from '../core/minimize';
import { getTimestamp, generateSnapshotId, generateRemoveId, generateBatchId, generateBgOpId } from '../utils/common';
import {
  saveProjectConfig,
  loadProjectConfig,
  saveAssetIndex,
  loadAssetIndex,
  saveAssetFile,
  loadAssetFile,
  loadAssetFileAsDataUrl,
  deleteAssetFile,
  saveBoardEvents,
  loadBoardEvents as loadBoardEventsFromDB,
  saveBoardSnapshot,
  loadBoardSnapshot as loadBoardSnapshotFromDB,
  deleteBoardSnapshot,
  deleteBoardData,
  clearAllData,
  saveBoardThumbnail,
  loadBoardThumbnail,
} from '../utils/storage';
import type { StoredAssetFile } from '../utils/storage';
import { generateThumbnail } from '../utils/thumbnail';

// ========================================
// ストア状態
// ========================================

/** インポートされたアセットの情報（UI表示用） */
export interface ImportedAsset {
  uuid: string;
  fileName: string;
  mimeType: string;
  size: number;
  type: 'image' | 'document';
  dataUrl?: string; // サムネイル用
}

interface ProjectState {
  project: Project | null;
  isLoading: boolean;
  isInitialized: boolean;
  error: string | null;
  
  // boardId → UUID マッピング（永続化用）
  boardUuids: Map<string, string>;
  
  // boardId → objectURL（サムネイル表示用）
  boardThumbnailUrls: Map<string, string>;
  
  // アクション
  initialize: () => Promise<void>;
  createNew: (name: string) => Promise<void>;
  loadFromFile: (file: File) => Promise<void>;
  save: () => Promise<Blob | null>;
  clearProject: () => Promise<void>;
  
  // プロジェクト操作
  renameProject: (name: string) => Promise<void>;
  
  // ボード操作
  addBoard: (name: string) => Promise<string | null>;
  renameBoard: (boardId: string, name: string) => Promise<void>;
  setBoardCanvasSize: (boardId: string, width: number | undefined, height: number | undefined) => Promise<void>;
  updateBackground: (bg: Partial<BackgroundConfig>) => Promise<void>;
  deleteBoard: (boardId: string) => Promise<void>;
  duplicateBoard: (boardId: string) => Promise<string | null>;
  minimizeBoard: (boardId: string, targetBoardId?: string) => Promise<{ beforeEventCount: number; afterEventCount: number; activeStrokeCount: number; activeOverlayCount: number } | null>;
  updateBoardEvents: (boardId: string, events: WbelxEvent[]) => Promise<void>;
  getBoardEvents: (boardId: string) => WbelxEvent[];
  loadBoardEventsAsync: (boardId: string) => Promise<WbelxEvent[]>;
  reorderBoards: (orderedIds: string[]) => Promise<void>;
  regenerateThumbnail: (boardId: string, currentStrokes?: DrawEvent[], currentOverlays?: OverlayState[]) => Promise<void>;
  
  // スナップショット操作
  saveBoardWithSnapshot: (boardId: string, events: WbelxEvent[], sessionId: string) => Promise<void>;
  loadBoardSnapshot: (boardId: string) => Promise<WbelxEvent[] | null>;
  clearBoardSnapshot: (boardId: string) => Promise<void>;
  removeFinalSnapshotMarker: (boardId: string) => Promise<void>;
  
  // アセット操作
  importAsset: (file: File) => Promise<string | null>;
  deleteAsset: (uuid: string) => Promise<void>;
  getAssets: () => ImportedAsset[];
  loadAssetDataUrl: (uuid: string) => Promise<string | null>;
  
  // アセット参照更新（オーバーレイ追加/削除時）
  onAssetAddedToBoard: (boardUuid: string, assetUuid: string) => Promise<void>;
  onAssetRemovedFromBoard: (boardUuid: string, assetUuid: string) => Promise<void>;
  
  // プロジェクト情報
  getBoards: () => BoardInfo[];
  getBoardUuid: (boardId: string) => string | undefined;
}

// ========================================
// Zustand ストア
// ========================================

export const useProjectStore = create<ProjectState>((set: (partial: Partial<ProjectState>) => void, get: () => ProjectState) => ({
  project: null,
  isLoading: false,
  isInitialized: false,
  error: null,
  boardUuids: new Map(),
  boardThumbnailUrls: new Map(),

  // 初期化（IndexedDB からデータを読み込む）
  initialize: async () => {
    if (get().isInitialized) return;
    
    set({ isLoading: true });
    
    try {
      const config = await loadProjectConfig();
      const assetIndex = await loadAssetIndex();
      
      // assetIndex から boardUuids を派生
      const boardUuids = new Map<string, string>();
      for (const [, asset] of assetIndex.byUuid) {
        if (asset.type === 'board') {
          const match = asset.relativePath.match(/^boards\/(\d+)\.wbelx$/);
          if (match) {
            boardUuids.set(match[1], asset.uuid);
          }
        }
      }
      
      if (config) {
        // プロジェクトを復元
        const boards = new Map<string, WbelxEvent[]>();
        
        // 各ボードのイベントを読み込む
        for (const boardId of config.boards.keys()) {
          const events = await loadBoardEventsFromDB(boardId);
          boards.set(boardId, events);
        }
        
        const project: Project = {
          config,
          boards,
          assetIndex,
          assetFiles: new Map(),
          snapshots: new Map(),
          thumbnails: new Map(),
        };
        
        // サムネイルを読み込み
        const boardThumbnailUrls = new Map<string, string>();
        for (const boardId of config.boards.keys()) {
          const blob = await loadBoardThumbnail(boardId);
          if (blob) {
            boardThumbnailUrls.set(boardId, URL.createObjectURL(blob));
          }
        }
        
        // サムネイルがないボードは自動生成
        for (const [boardId, events] of boards) {
          if (!boardThumbnailUrls.has(boardId) && events.length > 0) {
            const boardState = computeState(events);
            const strokes = getActiveStrokes(boardState);
            const overlays = getActiveOverlays(boardState);
            const blob = generateThumbnail(strokes, overlays, config.background);
            if (blob) {
              await saveBoardThumbnail(boardId, blob);
              boardThumbnailUrls.set(boardId, URL.createObjectURL(blob));
            }
          }
        }
        
        set({ 
          project, 
          boardUuids,
          boardThumbnailUrls,
          isLoading: false, 
          isInitialized: true 
        });
      } else {
        set({ isLoading: false, isInitialized: true });
      }
    } catch (error) {
      console.error('[Store] Failed to initialize:', error);
      set({ 
        isLoading: false, 
        isInitialized: true,
        error: error instanceof Error ? error.message : 'Failed to initialize' 
      });
    }
  },

  createNew: async (name: string) => {
    // 既存データをクリア
    await clearAllData();
    
    const project = createNewProject(name);
    
    // boardUuids を assetIndex から派生
    const boardUuids = new Map<string, string>();
    for (const [, asset] of project.assetIndex.byUuid) {
      if (asset.type === 'board') {
        const match = asset.relativePath.match(/^boards\/(\d+)\.wbelx$/);
        if (match) {
          boardUuids.set(match[1], asset.uuid);
        }
      }
    }
    
    // IndexedDB に保存
    await saveProjectConfig(project.config);
    await saveAssetIndex(project.assetIndex);
    
    set({ project, boardUuids, error: null });
  },

  loadFromFile: async (file: File) => {
    set({ isLoading: true, error: null });
    
    try {
      // 既存データをクリア
      await clearAllData();
      
      let project: Project;
      
      if (file.name.endsWith('.wbproj')) {
        project = await loadProject(file);
      } else {
        project = await loadSingleBoard(file);
      }
      
      // IndexedDB に保存
      await saveProjectConfig(project.config);
      await saveAssetIndex(project.assetIndex);
      
      // 各ボードのイベントを保存
      for (const [boardId, events] of project.boards.entries()) {
        await saveBoardEvents(boardId, events);
      }
      
      // アセットファイル（画像・PDF等）を保存
      for (const [uuid, file] of project.assetFiles) {
        await saveAssetFile({
          uuid,
          fileName: file.fileName,
          mimeType: file.mimeType,
          data: file.data,
          size: file.data.byteLength,
        });
      }
      
      // スナップショットを保存
      for (const [boardId, snapshotEvents] of project.snapshots) {
        if (snapshotEvents.length > 0) {
          await saveBoardSnapshot(boardId, snapshotEvents);
        }
      }
      
      // boardUuids を assetIndex から派生
      const boardUuids = new Map<string, string>();
      for (const [, asset] of project.assetIndex.byUuid) {
        if (asset.type === 'board') {
          const match = asset.relativePath.match(/^boards\/(\d+)\.wbelx$/);
          if (match) {
            boardUuids.set(match[1], asset.uuid);
          }
        }
      }
      
      // サムネイル保存・URL 生成
      const boardThumbnailUrls = new Map<string, string>();
      for (const [boardId, blob] of project.thumbnails) {
        await saveBoardThumbnail(boardId, blob);
        boardThumbnailUrls.set(boardId, URL.createObjectURL(blob));
      }
      
      // サムネイルがないボードは自動生成
      for (const [boardId, events] of project.boards) {
        if (!boardThumbnailUrls.has(boardId) && events.length > 0) {
          const boardState = computeState(events);
          const strokes = getActiveStrokes(boardState);
          const overlays = getActiveOverlays(boardState);
          const blob = generateThumbnail(strokes, overlays, project.config.background);
          if (blob) {
            await saveBoardThumbnail(boardId, blob);
            project.thumbnails.set(boardId, blob);
            boardThumbnailUrls.set(boardId, URL.createObjectURL(blob));
          }
        }
      }
      
      set({ project, boardUuids, boardThumbnailUrls, isLoading: false });
    } catch (error) {
      set({ 
        isLoading: false, 
        error: error instanceof Error ? error.message : 'Failed to load file' 
      });
      throw error;
    }
  },

  save: async () => {
    const { project } = get();
    if (!project) return null;
    
    try {
      // エクスポート用にボードイベントを IndexedDB から最新を再取得
      for (const boardId of project.config.boards.keys()) {
        const events = await loadBoardEventsFromDB(boardId);
        if (events && events.length > 0) {
          project.boards.set(boardId, events);
        }
      }
      
      // エクスポート用にアセットファイルを IndexedDB からロード
      for (const [uuid, asset] of project.assetIndex.byUuid) {
        if (asset.type !== 'board' && !project.assetFiles.has(uuid)) {
          const stored = await loadAssetFile(uuid);
          if (stored) {
            project.assetFiles.set(uuid, {
              data: stored.data,
              mimeType: stored.mimeType,
              fileName: stored.fileName,
            });
          }
        }
      }
      
      // エクスポート用にスナップショットを IndexedDB からロード
      for (const boardId of project.config.boards.keys()) {
        if (!project.snapshots.has(boardId)) {
          const snapshotEvents = await loadBoardSnapshotFromDB(boardId);
          if (snapshotEvents && snapshotEvents.length > 0) {
            project.snapshots.set(boardId, snapshotEvents);
          }
        }
      }
      
      // エクスポート用にサムネイルを IndexedDB からロード
      for (const boardId of project.config.boards.keys()) {
        if (!project.thumbnails.has(boardId)) {
          const blob = await loadBoardThumbnail(boardId);
          if (blob) {
            project.thumbnails.set(boardId, blob);
          }
        }
      }
      
      const blob = await saveProject(project);
      return blob;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to save' });
      return null;
    }
  },

  clearProject: async () => {
    await clearAllData();
    set({ project: null, boardUuids: new Map(), error: null });
  },

  renameProject: async (name: string) => {
    const { project } = get();
    if (!project) return;
    
    const newProject = {
      ...project,
      config: {
        ...project.config,
        project: {
          ...project.config.project,
          name,
          updatedAt: new Date().toISOString(),
        },
      },
    };
    
    set({ project: newProject });
    await saveProjectConfig(newProject.config);
  },

  addBoard: async (name: string) => {
    const { project, boardUuids } = get();
    if (!project) return null;
    
    const newId = addBoardToProject(project, name);
    
    // UUID を取得
    const uuid = getBoardUuid(project, newId);
    if (uuid) {
      boardUuids.set(newId, uuid);
    }
    
    // 新しい Project オブジェクトを作成
    const newProject = { 
      ...project,
      config: {
        ...project.config,
        boards: new Map(project.config.boards),
      },
      boards: new Map(project.boards),
      assetIndex: project.assetIndex, // 同じ参照を維持（addBoardToProject で更新済み）
    };
    
    // IndexedDB に保存
    await saveProjectConfig(newProject.config);
    await saveAssetIndex(newProject.assetIndex);
    await saveBoardEvents(newId, []);
    
    set({ project: newProject, boardUuids: new Map(boardUuids) });
    return newId;
  },

  renameBoard: async (boardId: string, name: string) => {
    const { project } = get();
    if (!project) return;
    
    const boardInfo = project.config.boards.get(boardId);
    if (!boardInfo) return;
    
    const newConfigBoards = new Map(project.config.boards);
    newConfigBoards.set(boardId, {
      ...boardInfo,
      name,
      updatedAt: new Date().toISOString(),
    });
    
    const newProject = {
      ...project,
      config: {
        ...project.config,
        boards: newConfigBoards,
      },
    };
    
    set({ project: newProject });
    await saveProjectConfig(newProject.config);
  },

  setBoardCanvasSize: async (boardId: string, width: number | undefined, height: number | undefined) => {
    const { project } = get();
    if (!project) return;
    
    const boardInfo = project.config.boards.get(boardId);
    if (!boardInfo) return;
    
    const newConfigBoards = new Map(project.config.boards);
    const updated = { ...boardInfo, updatedAt: new Date().toISOString() };
    if (width && height) {
      updated.canvasWidth = width;
      updated.canvasHeight = height;
    } else {
      delete updated.canvasWidth;
      delete updated.canvasHeight;
    }
    newConfigBoards.set(boardId, updated);
    
    const newProject = {
      ...project,
      config: {
        ...project.config,
        boards: newConfigBoards,
      },
    };
    
    set({ project: newProject });
    await saveProjectConfig(newProject.config);
  },

  updateBackground: async (bg: Partial<BackgroundConfig>) => {
    const { project } = get();
    if (!project) return;

    const newProject = {
      ...project,
      config: {
        ...project.config,
        background: { ...project.config.background, ...bg },
      },
    };

    set({ project: newProject });
    await saveProjectConfig(newProject.config);
  },

  deleteBoard: async (boardId: string) => {
    const { project, boardUuids } = get();
    if (!project) return;
    
    // 最後の1つは削除不可
    if (project.config.boards.size <= 1) return;
    
    // 削除対象ボードの UUID
    const deletedUuid = boardUuids.get(boardId);
    
    // 他ボードから削除対象ボードを参照しているオーバーレイを OR で論理削除
    const newBoards = new Map(project.boards);
    if (deletedUuid) {
      for (const [otherBoardId, events] of newBoards) {
        if (otherBoardId === boardId) continue;
        const state = computeState(events);
        const overlaysToRemove = getActiveOverlays(state)
          .filter(o => o.assetUuid === deletedUuid)
          .map(o => o.overlayId);
        if (overlaysToRemove.length > 0) {
          const ts = getTimestamp();
          let removeEvents: WbelxEvent[];
          if (overlaysToRemove.length === 1) {
            removeEvents = [{
              type: 'OR',
              timestamp: ts,
              sessionId: 'system',
              removeId: generateRemoveId(),
              targetOverlayId: overlaysToRemove[0],
            }];
          } else {
            const subEvents = overlaysToRemove.map(oid => ({
              type: 'OR' as const,
              timestamp: ts,
              sessionId: 'system',
              removeId: generateRemoveId(),
              targetOverlayId: oid,
            }));
            removeEvents = [{
              type: 'BATCH',
              id: generateBatchId(),
              timestamp: ts,
              sessionId: 'system',
              events: subEvents,
            }];
          }
          const updatedEvents = [...events, ...removeEvents];
          newBoards.set(otherBoardId, updatedEvents);
          await saveBoardEvents(otherBoardId, updatedEvents);
          // assetIndex の referencedBy を更新
          const otherBoardUuid = boardUuids.get(otherBoardId);
          if (otherBoardUuid) {
            const childAsset = project.assetIndex.byUuid.get(deletedUuid);
            if (childAsset) {
              for (const _overlayId of overlaysToRemove) {
                onOverlayRemoved(otherBoardUuid, childAsset, project.assetIndex);
              }
            }
          }
        }
      }
    }
    
    // ボード情報を削除
    const newConfigBoards = new Map(project.config.boards);
    newConfigBoards.delete(boardId);
    
    // ボードイベントを削除
    newBoards.delete(boardId);
    
    // UUID マッピングを削除
    const newBoardUuids = new Map(boardUuids);
    newBoardUuids.delete(boardId);
    
    // assetIndex から削除
    if (deletedUuid) {
      removeFromAssetIndex(project.assetIndex, deletedUuid);
    }
    
    const newProject = {
      ...project,
      config: {
        ...project.config,
        boards: newConfigBoards,
      },
      boards: newBoards,
      assetIndex: project.assetIndex,
    };
    
    set({ project: newProject, boardUuids: newBoardUuids });
    
    // IndexedDB から削除
    await saveProjectConfig(newProject.config);
    await saveAssetIndex(newProject.assetIndex);
    await deleteBoardData(boardId);
  },

  updateBoardEvents: async (boardId: string, events: WbelxEvent[]) => {
    const { project } = get();
    if (!project) return;
    
    // メモリ内を更新
    const newBoards = new Map(project.boards);
    newBoards.set(boardId, events);
    
    const newConfigBoards = new Map(project.config.boards);
    const boardInfo = newConfigBoards.get(boardId);
    if (boardInfo) {
      newConfigBoards.set(boardId, {
        ...boardInfo,
        updatedAt: new Date().toISOString(),
      });
    }
    
    const newProject = { 
      ...project,
      config: { ...project.config, boards: newConfigBoards },
      boards: newBoards,
    };
    
    set({ project: newProject });
    
    // IndexedDB に保存
    await saveBoardEvents(boardId, events);
    await saveProjectConfig(newProject.config);
  },

  getBoardEvents: (boardId: string) => {
    const { project } = get();
    if (!project) return [];
    return project.boards.get(boardId) || [];
  },

  loadBoardEventsAsync: async (boardId: string) => {
    const events = await loadBoardEventsFromDB(boardId);
    return events;
  },

  // ボードの順序を変更
  reorderBoards: async (orderedIds: string[]) => {
    const { project } = get();
    if (!project) return;
    
    const newConfigBoards = new Map(project.config.boards);
    
    // displayOrder を更新
    orderedIds.forEach((id, index) => {
      const boardInfo = newConfigBoards.get(id);
      if (boardInfo) {
        newConfigBoards.set(id, {
          ...boardInfo,
          displayOrder: index + 1,
        });
      }
    });
    
    const newProject = { 
      ...project,
      config: { ...project.config, boards: newConfigBoards },
    };
    
    set({ project: newProject });
    
    // IndexedDB に保存
    await saveProjectConfig(newProject.config);
  },

  // サムネイルを再生成
  regenerateThumbnail: async (boardId: string, currentStrokes?: DrawEvent[], currentOverlays?: OverlayState[]) => {
    const { project, boardThumbnailUrls } = get();
    if (!project) return;

    let strokes: DrawEvent[];
    let overlays: OverlayState[];

    if (currentStrokes && currentOverlays) {
      // 呼び出し元から最新状態が渡された場合はそのまま使用
      strokes = currentStrokes;
      overlays = currentOverlays;
    } else {
      // store の boards から計算（初期化・ファイル読み込み時用）
      const events = project.boards.get(boardId);
      if (!events) return;
      const state = computeState(events);
      strokes = getActiveStrokes(state);
      overlays = getActiveOverlays(state);
    }
    const blob = generateThumbnail(strokes, overlays, project.config.background);
    if (!blob) return;

    // IndexedDB に保存
    await saveBoardThumbnail(boardId, blob);

    // Project にも保持（エクスポート用）
    project.thumbnails.set(boardId, blob);

    // objectURL を更新
    const oldUrl = boardThumbnailUrls.get(boardId);
    if (oldUrl) URL.revokeObjectURL(oldUrl);
    const newUrls = new Map(boardThumbnailUrls);
    newUrls.set(boardId, URL.createObjectURL(blob));
    set({ boardThumbnailUrls: newUrls });
  },

  // ボードを複製
  duplicateBoard: async (boardId: string) => {
    const { project, boardUuids } = get();
    if (!project) return null;

    const srcInfo = project.config.boards.get(boardId);
    const srcEvents = project.boards.get(boardId);
    if (!srcInfo || !srcEvents) return null;

    // 新しい ID を生成（既存 ID の最大値 + 1）
    const existingIds = Array.from(project.config.boards.keys()).map(Number).filter(n => !isNaN(n));
    const nextId = String(Math.max(...existingIds, 0) + 1).padStart(4, '0');
    const newUuid = generateUuid();

    // ボード情報を作成
    const newBoardInfo = createBoardInfo(
      nextId,
      `${srcInfo.name} (Copy)`,
      srcInfo.displayOrder + 1,
    );

    // displayOrder を調整（複製元より後ろのものを +1）
    const newConfigBoards = new Map(project.config.boards);
    for (const [id, info] of newConfigBoards) {
      if (info.displayOrder > srcInfo.displayOrder) {
        newConfigBoards.set(id, { ...info, displayOrder: info.displayOrder + 1 });
      }
    }
    newConfigBoards.set(nextId, newBoardInfo);

    // イベントをコピー
    const newBoards = new Map(project.boards);
    newBoards.set(nextId, [...srcEvents]);

    // wbasset を作成
    const boardAsset: import('../types').WbAsset = {
      uuid: newUuid,
      type: 'board',
      originalName: `${srcInfo.name} (copy)`,
      mimeType: 'application/x-wbelx',
      fileSize: 0,
      relativePath: `boards/${nextId}.wbelx`,
      referencedBy: [],
      allAncestors: [],
    };
    addToAssetIndex(project.assetIndex, boardAsset);

    const newBoardUuids = new Map(boardUuids);
    newBoardUuids.set(nextId, newUuid);

    const newProject = {
      ...project,
      config: { ...project.config, boards: newConfigBoards },
      boards: newBoards,
    };

    set({ project: newProject, boardUuids: newBoardUuids });

    // IndexedDB に保存
    await saveProjectConfig(newProject.config);
    await saveAssetIndex(newProject.assetIndex);
    await saveBoardEvents(nextId, srcEvents);

    // スナップショットもコピー
    const srcSnapshot = await loadBoardSnapshotFromDB(boardId);
    if (srcSnapshot && srcSnapshot.length > 0) {
      await saveBoardSnapshot(nextId, srcSnapshot);
    }

    return nextId;
  },

  /**
   * ボードを Minimize する（破壊的操作）。
   * targetBoardId が指定されている場合はそのボードを上書き。
   * 指定がない場合は元のボード自体を上書き。
   */
  minimizeBoard: async (boardId: string, targetBoardId?: string) => {
    const { project } = get();
    if (!project) return null;

    const srcEvents = project.boards.get(boardId);
    if (!srcEvents || srcEvents.length === 0) return null;

    const srcInfo = project.config.boards.get(boardId);
    if (!srcInfo) return null;

    // Minimize 実行
    const result = minimizeWbelx(srcEvents, { getTimestamp, generateBgOpId });

    const effectiveTargetId = targetBoardId || boardId;

    // ターゲットボードのイベントを更新
    const newBoards = new Map(project.boards);
    newBoards.set(effectiveTargetId, result.events);

    // updatedAt を更新
    const newConfigBoards = new Map(project.config.boards);
    const targetInfo = newConfigBoards.get(effectiveTargetId);
    if (targetInfo) {
      newConfigBoards.set(effectiveTargetId, {
        ...targetInfo,
        updatedAt: new Date().toISOString(),
      });
    }

    const newProject = {
      ...project,
      config: { ...project.config, boards: newConfigBoards },
      boards: newBoards,
    };

    set({ project: newProject });

    // IndexedDB に保存
    await saveProjectConfig(newProject.config);
    await saveBoardEvents(effectiveTargetId, result.events);

    // スナップショットをクリア（イベントが変わったため）
    await deleteBoardSnapshot(effectiveTargetId);

    return {
      beforeEventCount: result.beforeEventCount,
      afterEventCount: result.afterEventCount,
      activeStrokeCount: result.activeStrokeCount,
      activeOverlayCount: result.activeOverlayCount,
    };
  },

  // ボードを S イベント付きで保存し、スナップショットも作成
  saveBoardWithSnapshot: async (boardId: string, events: WbelxEvent[], sessionId: string) => {
    const { project } = get();
    if (!project) return;
    
    // 現在の状態を計算
    const state = computeState(events);
    const activeStrokes = getActiveStrokes(state);
    const activeOverlays = getActiveOverlays(state);
    
    // S イベントを作成
    const snapshotMarker: SnapshotMarkerEvent = {
      type: 'S',
      timestamp: getTimestamp(),
      sessionId,
      snapshotHash: generateSnapshotId(),
    };
    
    // イベントに S を追加
    const eventsWithSnapshot = [...events, snapshotMarker];
    
    // メモリ内を更新
    const newBoards = new Map(project.boards);
    newBoards.set(boardId, eventsWithSnapshot);
    
    const newConfigBoards = new Map(project.config.boards);
    const boardInfo = newConfigBoards.get(boardId);
    if (boardInfo) {
      newConfigBoards.set(boardId, {
        ...boardInfo,
        updatedAt: new Date().toISOString(),
      });
    }
    
    const newProject = { 
      ...project,
      config: { ...project.config, boards: newConfigBoards },
      boards: newBoards,
    };
    
    set({ project: newProject });
    
    // スナップショットイベントを作成（ストローク + オーバーレイ）
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
    
    // IndexedDB に保存
    await saveBoardEvents(boardId, eventsWithSnapshot);
    await saveBoardSnapshot(boardId, snapshotEvents);
    await saveProjectConfig(newProject.config);
    
    // サムネイル再生成（非同期、エラーは無視）
    try {
      const blob = generateThumbnail(activeStrokes, activeOverlays, project.config.background);
      if (blob) {
        await saveBoardThumbnail(boardId, blob);
        newProject.thumbnails.set(boardId, blob);
        const { boardThumbnailUrls } = get();
        const oldUrl = boardThumbnailUrls.get(boardId);
        if (oldUrl) URL.revokeObjectURL(oldUrl);
        const newUrls = new Map(boardThumbnailUrls);
        newUrls.set(boardId, URL.createObjectURL(blob));
        set({ boardThumbnailUrls: newUrls });
      }
    } catch { /* サムネイル生成失敗は無視 */ }
    
  },

  // スナップショットを読み込む
  loadBoardSnapshot: async (boardId: string) => {
    return await loadBoardSnapshotFromDB(boardId);
  },

  // スナップショットをクリア
  clearBoardSnapshot: async (boardId: string) => {
    await deleteBoardSnapshot(boardId);
  },

  // 末尾の S イベントを削除（ゲストと同期する場合）
  removeFinalSnapshotMarker: async (boardId: string) => {
    const { project } = get();
    if (!project) return;
    
    const events = project.boards.get(boardId);
    if (!events || events.length === 0) return;
    
    // 末尾から S イベントを探して削除
    const newEvents = [...events];
    while (newEvents.length > 0 && newEvents[newEvents.length - 1].type === 'S') {
      newEvents.pop();
    }
    
    if (newEvents.length !== events.length) {
      const newBoards = new Map(project.boards);
      newBoards.set(boardId, newEvents);
      
      const newProject = { 
        ...project,
        boards: newBoards,
      };
      
      set({ project: newProject });
      
      // IndexedDB に保存
      await saveBoardEvents(boardId, newEvents);
      
    }
  },

  getBoards: () => {
    const { project } = get();
    if (!project) return [];
    return Array.from(project.config.boards.values());
  },

  getBoardUuid: (boardId: string) => {
    const { project, boardUuids } = get();
    
    // まずキャッシュを確認
    if (boardUuids.has(boardId)) {
      return boardUuids.get(boardId);
    }
    
    // なければ計算
    if (!project) return undefined;
    return getBoardUuid(project, boardId);
  },

  // ========================================
  // アセット操作
  // ========================================

  importAsset: async (file: File) => {
    const { project } = get();
    if (!project) return null;
    
    // MIME タイプを判定
    const mimeType = file.type;
    let assetType: AssetType;
    
    if (mimeType.startsWith('image/')) {
      assetType = 'image';
    } else if (mimeType === 'application/pdf') {
      assetType = 'document';
    } else {
      // サポートしていないファイルタイプ
      return null;
    }
    
    // UUID を生成
    const uuid = generateUuid();
    // wbproj-spec-v3: assets/<uuid>.<ext> フラット構造
    const ext = file.name.includes('.') ? file.name.split('.').pop() : 'bin';
    const relativePath = `assets/${uuid}.${ext}`;
    
    // ファイルを読み込み
    const arrayBuffer = await file.arrayBuffer();
    
    // IndexedDB にファイルを保存
    const storedFile: StoredAssetFile = {
      uuid,
      fileName: file.name,
      mimeType,
      data: arrayBuffer,
      size: file.size,
    };
    await saveAssetFile(storedFile);
    
    // wbasset を作成
    const wbasset: WbAsset = {
      uuid,
      type: assetType,
      originalName: file.name,
      mimeType,
      fileSize: file.size,
      relativePath,
      referencedBy: [],
      allAncestors: [],
    };
    addToAssetIndex(project.assetIndex, wbasset);
    
    // プロジェクト設定に追加
    project.config.assets.set(uuid, {
      uuid,
      originalPath: file.name,
      importedBy: '',
      importedAt: new Date().toISOString(),
    });
    
    // IndexedDB に保存
    await saveAssetIndex(project.assetIndex);
    await saveProjectConfig(project.config);
    
    // 状態を更新
    set({ project: { ...project } });
    
    return uuid;
  },

  deleteAsset: async (uuid: string) => {
    const { project } = get();
    if (!project) return;
    
    const asset = project.assetIndex.byUuid.get(uuid);
    if (!asset) return;
    
    // ボードは削除不可
    if (asset.type === 'board') return;
    
    // 参照されている場合は削除不可
    if (asset.referencedBy.length > 0) {
      return;
    }
    
    // assetIndex から削除
    removeFromAssetIndex(project.assetIndex, uuid);
    
    // プロジェクト設定から削除
    project.config.assets.delete(uuid);
    
    // IndexedDB から削除
    await deleteAssetFile(uuid);
    await saveAssetIndex(project.assetIndex);
    await saveProjectConfig(project.config);
    
    // 状態を更新
    set({ project: { ...project } });
  },

  getAssets: () => {
    const { project } = get();
    if (!project) return [];
    
    const assets: ImportedAsset[] = [];
    
    for (const [, asset] of project.assetIndex.byUuid) {
      // ボードは除外
      if (asset.type === 'board') continue;
      
      const info = project.config.assets.get(asset.uuid);
      if (info) {
        assets.push({
          uuid: asset.uuid,
          fileName: asset.originalName || info.originalPath,
          mimeType: asset.mimeType,
          size: asset.fileSize,
          type: asset.type as 'image' | 'document',
        });
      }
    }
    
    return assets;
  },

  loadAssetDataUrl: async (uuid: string) => {
    return loadAssetFileAsDataUrl(uuid);
  },

  // アセット参照更新（オーバーレイ追加時）
  onAssetAddedToBoard: async (boardUuid: string, assetUuid: string) => {
    const { project } = get();
    if (!project) return;
    
    const asset = project.assetIndex.byUuid.get(assetUuid);
    if (!asset) return;
    
    // referencedBy と allAncestors を更新
    onOverlayAdded(boardUuid, asset, project.assetIndex);
    
    // IndexedDB に保存
    await saveAssetIndex(project.assetIndex);
  },

  // アセット参照更新（オーバーレイ削除時）
  onAssetRemovedFromBoard: async (boardUuid: string, assetUuid: string) => {
    const { project } = get();
    if (!project) return;
    
    const asset = project.assetIndex.byUuid.get(assetUuid);
    if (!asset) return;
    
    // referencedBy と allAncestors を更新
    onOverlayRemoved(boardUuid, asset, project.assetIndex);
    
    // IndexedDB に保存
    await saveAssetIndex(project.assetIndex);
  },
}));
