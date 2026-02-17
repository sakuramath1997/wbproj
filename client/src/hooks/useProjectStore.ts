import { create } from 'zustand';
import type { BoardInfo, WbelxEvent, SnapshotMarkerEvent, WbAsset, AssetType } from '../types';
import { removeFromAssetIndex, addToAssetIndex, onOverlayAdded, onOverlayRemoved } from '../types';
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
import { computeState, getActiveStrokes, getActiveOverlays } from '../utils/statemachine';
import { getTimestamp, generateSnapshotId } from '../utils/common';
import {
  saveProjectConfig,
  loadProjectConfig,
  saveAssetIndex,
  loadAssetIndex,
  saveAssetFile,
  loadAssetFileAsDataUrl,
  deleteAssetFile,
  saveBoardEvents,
  loadBoardEvents as loadBoardEventsFromDB,
  saveBoardSnapshot,
  loadBoardSnapshot as loadBoardSnapshotFromDB,
  deleteBoardSnapshot,
  deleteBoardData,
  clearAllData,
} from '../utils/storage';
import type { StoredAssetFile } from '../utils/storage';

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
  deleteBoard: (boardId: string) => Promise<void>;
  updateBoardEvents: (boardId: string, events: WbelxEvent[]) => Promise<void>;
  getBoardEvents: (boardId: string) => WbelxEvent[];
  loadBoardEventsAsync: (boardId: string) => Promise<WbelxEvent[]>;
  reorderBoards: (orderedIds: string[]) => Promise<void>;
  
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

export const useProjectStore = create<ProjectState>((set, get) => ({
  project: null,
  isLoading: false,
  isInitialized: false,
  error: null,
  boardUuids: new Map(),

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
        };
        
        set({ 
          project, 
          boardUuids,
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
      
      set({ project, boardUuids, isLoading: false });
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

  deleteBoard: async (boardId: string) => {
    const { project, boardUuids } = get();
    if (!project) return;
    
    // 最後の1つは削除不可
    if (project.config.boards.size <= 1) return;
    
    // ボード情報を削除
    const newConfigBoards = new Map(project.config.boards);
    newConfigBoards.delete(boardId);
    
    // ボードイベントを削除
    const newBoards = new Map(project.boards);
    newBoards.delete(boardId);
    
    // UUID マッピングを削除
    const uuid = boardUuids.get(boardId);
    const newBoardUuids = new Map(boardUuids);
    newBoardUuids.delete(boardId);
    
    // assetIndex から削除
    if (uuid) {
      removeFromAssetIndex(project.assetIndex, uuid);
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
    let newEvents = [...events];
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
    let category: string;
    
    if (mimeType.startsWith('image/')) {
      assetType = 'image';
      category = 'images';
    } else if (mimeType === 'application/pdf') {
      assetType = 'document';
      category = 'documents';
    } else {
      // サポートしていないファイルタイプ
      return null;
    }
    
    // UUID を生成
    const uuid = generateUuid();
    const relativePath = `imported/${category}/${file.name}`;
    
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
      mimeType,
      fileSize: file.size,
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
          fileName: info.originalPath,
          mimeType: info.mimeType,
          size: info.fileSize,
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
