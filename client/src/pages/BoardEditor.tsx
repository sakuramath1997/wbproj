import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useProjectStore } from '../hooks/useProjectStore';
import { useYjsSync } from '../hooks/useYjsSync';
import { useUndoRedo } from '../hooks/useUndoRedo';
import { useLassoOps } from '../hooks/useLassoOps';
import { useP2pAssetTransfer } from '../hooks/useP2pAssetTransfer';
import { useKeyboard } from '../hooks/useKeyboard';
import { useBackground } from '../hooks/useBackground';
import { usePersistence } from '../hooks/usePersistence';
import { useOverlayOps } from '../hooks/useOverlayOps';
import { useOverlayDisplay } from '../hooks/useOverlayDisplay';
import { useObjectLock } from '../hooks/useObjectLock';
import { WhiteboardCanvas } from '../components/WhiteboardCanvas';
import { Toolbar } from '../components/Toolbar';
import { OverlayInlineControls } from '../components/OverlayInlineControls';
import { ViewportEditor } from '../components/ViewportEditor';
import { LassoActionBar } from '../components/LassoActionBar';
import type { 
  ToolType, 
  StrokeWidthKey, 
  WbelxEvent, 
  OverlayState,
  CanvasTransform,
  AssetIndex,
  LassoSelection,
  LassoClipboard,
  DrawEvent,
  EraseEvent,
  BatchEvent,
  SubEvent,
  SingleOperation,
  OverlayTransformEvent,
} from '../types';
import { STROKE_WIDTHS, COLOR_PALETTE, canAddAsOverlay } from '../types';
import {
  getTimestamp, generateCsOpId, generateEraseId, generateBatchId,
  generateTransformOpId,
} from '../utils/common';
import {
  loadBoardEvents,
  loadBoardSnapshot,
} from '../utils/storage';
import { computeLassoBBox } from '../core/lasso-engine';

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
  const { project, getBoardUuid, getAssets, getBoards, onAssetAddedToBoard, onAssetRemovedFromBoard, importAsset, loadBoardEventsAsync, regenerateThumbnail, setBoardCanvasSize, updateBackground } = useProjectStore();

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
  
  // オーバーレイ関連（selectedOverlayId, viewportEditorOverlayId は useOverlayOps が管理）
  // overlayDisplayStates, overlayRenderKeyRef, overlayOpacityOverrides,
  // overlayLockAspectRatios, pdfPageCounts → useOverlayDisplay に移動

  // WhiteboardCanvas の現在の transform（ズームレベル変化でボードサムネイルを再生成する）
  // インラインコントロール用
  const [canvasTransformFull, setCanvasTransformFull] = useState<CanvasTransform>({ x: 0, y: 0, scale: 1 });
  // 投げ縄選択状態
  const [lassoSelection, setLassoSelection] = useState<LassoSelection | null>(null);
  const [lassoClipboard, setLassoClipboard] = useState<LassoClipboard | null>(null);
  // 複製/貼り付け後に WhiteboardCanvas の選択を外部から設定するための状態
  const [pendingLassoSelection, setPendingLassoSelection] = useState<LassoSelection | null>(null);
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
  
  // ViewportEditor (viewportEditorOverlayId は useOverlayOps が管理)

  // ゲスト用アセットインデックス（P2P メタデータ受信時に構築）
  const [guestAssetIndex, setGuestAssetIndex] = useState<AssetIndex | null>(null);
  // アセット受信バージョン（IndexedDB 保存完了時にインクリメント → 画像再読み込みトリガー）
  const [assetReceivedVersion, setAssetReceivedVersion] = useState(0);

  // ボード情報
  const boardInfo = boardId ? project?.config.boards.get(boardId) : undefined;
  const localBoardUuid = boardId ? getBoardUuid(boardId) : undefined;

  // 固定キャンバスサイズ（undefined = 無限キャンバス）
  // 共有リンク判定
  const roomIdFromQuery = searchParams.get('room');
  const isJoiningViaShareLink = !!roomIdFromQuery;
  const isHost = !!project && !isJoiningViaShareLink;
  
  const roomId = useMemo(() => {
    return roomIdFromQuery || localBoardUuid || '';
  }, [roomIdFromQuery, localBoardUuid]);

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

  // ========================================
  // P2P コラボレーション (useYjsSync)
  // ========================================
  const undoRedoStartBuildRef = useRef<(events: WbelxEvent[]) => void>(() => {});
  const stableOnEventsLoaded = useCallback((evts: WbelxEvent[]) => undoRedoStartBuildRef.current(evts), []);

  const {
    isConnected,
    peerCount,
    state,
    activeStrokes,
    activeOverlays,
    cursors,
    sessionId,
    appendEvent,
    appendEvents,
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
    provider,
    stateRef,
  } = useYjsSync({
    roomId,
    enabled: !!roomId && !isLoading,
    isHost,
    initialEvents,
    onPeerJoin: handlePeerJoin,
    onPeerLeave: handlePeerLeave,
    onEventsLoaded: stableOnEventsLoaded,
  });

  // ========================================
  // Undo/Redo（hooks/useUndoRedo.ts に委譲）
  // ========================================
  const undoRedo = useUndoRedo({ sessionId, state, appendEvents });
  undoRedoStartBuildRef.current = undoRedo.startUndoStackBuild;

  const { performUndo, performRedo, canUndo, canRedo, pushOp } = undoRedo;

  // ========================================
  // 投げ縄操作（hooks/useLassoOps.ts に委譲）
  // ========================================
  const {
    lassoMoveSelection,
    lassoDeleteSelection,
    lassoDuplicateSelection,
    lassoPasteSelection,
  } = useLassoOps({
    sessionId,
    stateRef,
    pushEvent: appendEvent,
    pushOp,
  });

  // ========================================
  // Object Lock Protocol（hooks/useObjectLock.ts に委譲）
  // ========================================
  const {
    acquireLock,
    releaseLock,
    releaseAll: releaseAllLocks,
  } = useObjectLock({ sessionId, provider });

  // ========================================
  // ストローク / 消しゴム / OT イベント構築（WhiteboardCanvas 用）
  // ========================================
  const handleAddDrawEvent = useCallback((event: DrawEvent) => {
    const e = { ...event, sessionId: event.sessionId || sessionId };
    appendEvent(e);
    pushOp({ type: 'draw', strokeId: e.id, strokeData: e });
  }, [sessionId, appendEvent, pushOp]);

  const handleEraseStrokes = useCallback((targetStrokes: DrawEvent[]) => {
    if (targetStrokes.length === 0) return;
    const ts = getTimestamp();
    const sid = sessionId;

    if (targetStrokes.length === 1) {
      const e: EraseEvent = { type: 'E', timestamp: ts, sessionId: sid, id: generateEraseId(), targetId: targetStrokes[0].id };
      appendEvent(e);
      pushOp({ type: 'erase', eraseId: e.id, targetId: e.targetId, targetStroke: targetStrokes[0] });
    } else {
      const subEvents: SubEvent[] = [];
      const ops: SingleOperation[] = [];
      for (const stroke of targetStrokes) {
        const eid = generateEraseId();
        subEvents.push({ type: 'E', timestamp: ts, sessionId: sid, id: eid, targetId: stroke.id });
        ops.push({ type: 'erase', eraseId: eid, targetId: stroke.id, targetStroke: stroke });
      }
      const batch: BatchEvent = { type: 'BATCH', id: generateBatchId(), timestamp: ts, sessionId: sid, events: subEvents };
      appendEvent(batch);
      pushOp({ type: 'batch', batchId: batch.id, operations: ops });
    }
  }, [sessionId, appendEvent, pushOp]);

  const handleTransformOverlay = useCallback((
    overlayId: string,
    before: { x: number; y: number; width: number; height: number; rotation: number },
    after: { x: number; y: number; width: number; height: number; rotation: number },
  ) => {
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    const dWidth = after.width - before.width;
    const dHeight = after.height - before.height;
    const dRotation = after.rotation - before.rotation;
    const opId = generateTransformOpId();
    const e: OverlayTransformEvent = {
      type: 'OT', timestamp: getTimestamp(), sessionId, id: opId, overlayId,
      ...(dx !== 0 && { dx }), ...(dy !== 0 && { dy }),
      ...(dWidth !== 0 && { dWidth }), ...(dHeight !== 0 && { dHeight }),
      ...(dRotation !== 0 && { dRotation }),
    };
    appendEvent(e);
    pushOp({ type: 'overlayTransform', id: opId, overlayId, dx, dy, dWidth, dHeight, dRotation });
  }, [sessionId, appendEvent, pushOp]);

  const canvasSize = useMemo(() => {
    // CS イベントによる動的サイズを優先
    if (state.canvasWidth > 0 && state.canvasHeight > 0) {
      return { width: state.canvasWidth, height: state.canvasHeight };
    }
    // H ヘッダー由来の初期値をフォールバック
    if (boardInfo?.canvasWidth && boardInfo?.canvasHeight) {
      return { width: boardInfo.canvasWidth, height: boardInfo.canvasHeight };
    }
    return undefined;
  }, [state.canvasWidth, state.canvasHeight, boardInfo?.canvasWidth, boardInfo?.canvasHeight]);

  // ========================================
  // P2P アセット転送（Data Channel 経由）
  // ========================================
  const getAssetIndexForP2p = useCallback(() => project?.assetIndex ?? null, [project]);

  const handleProjectMetaReceived = useCallback((index: AssetIndex) => {
    setGuestAssetIndex(index);
  }, []);

  const handleAssetReceived = useCallback((_uuid: string) => {
    // IndexedDB 保存完了 → バージョンをインクリメントして画像再読み込みをトリガー
    setAssetReceivedVersion(v => v + 1);
  }, []);

  const {
    requestAsset: requestAssetP2p,
    transferProgress: assetTransferProgress,
  } = useP2pAssetTransfer({
    provider,
    isHost,
    getAssetIndex: getAssetIndexForP2p,
    onProjectMetaReceived: handleProjectMetaReceived,
    onAssetReceived: handleAssetReceived,
  });

  /** ホスト or ゲスト共通のアセットインデックス */
  const resolvedAssetIndex = project?.assetIndex ?? guestAssetIndex;

  // ========================================
  // オーバーレイ表示状態（hooks/useOverlayDisplay.ts に委譲）
  // ========================================
  const {
    overlayDisplayStates, setOverlayDisplayStates,
    overlayRenderKeyRef,
    overlayOpacityOverrides, setOverlayOpacityOverrides,
    overlayLockAspectRatios, setOverlayLockAspectRatios,
    overlayImages,
    pdfPageCounts,
    overlayAssetTypes,
  } = useOverlayDisplay({
    activeOverlays,
    canvasTransform,
    resolvedAssetIndex,
    background: project?.config.background,
    assetReceivedVersion,
    assetTransferProgress,
    requestAssetP2p: requestAssetP2p,
    getBoards,
    getBoardUuid,
    loadBoardEventsAsync,
  });


  // ========================================
  // オーバーレイ操作（hooks/useOverlayOps.ts に委譲）
  // ========================================
  const {
    selectedOverlayId, setSelectedOverlayId,
    viewportEditorOverlayId, setViewportEditorOverlayId,
    selectedOverlay, selectedOverlayAssetType,
    viewportEditorOverlay, viewportEditorAssetType, viewportEditorAssetName, sortedOverlays,
    handleAddAsset, handleRemoveOverlay,
    handleCloseViewportEditor, handleApplyViewport,
    handleOpacityCommit,
    handleBringToFront, handleBringForward, handleSendBackward, handleSendToBack,
    handleInlinePageChange, handleInlineDelete,
  } = useOverlayOps({
    sessionId,
    activeOverlays,
    localBoardUuid,
    project,
    guestAssetIndex,
    appendEvent,
    pushOp,
    onAssetAddedToBoard,
    onAssetRemovedFromBoard,
    getBoards,
    getBoardUuid,
    loadBoardEventsAsync,
    overlayRenderKeyRef,
    setOverlayDisplayStates,
    setOverlayOpacityOverrides,
    setOverlayLockAspectRatios,
  });

  // ========================================
  // Object Lock: ツール切替時のロック解放
  // ========================================
  const handleSetTool = useCallback((newTool: ToolType) => {
    // 前のツールの選択をクリアしつつロック解放
    if (tool !== newTool) {
      releaseAllLocks();
    }
    setTool(newTool);
  }, [tool, releaseAllLocks]);

  // ========================================
  // Object Lock: オーバーレイ選択時のロック取得
  // ========================================
  const handleSelectOverlay = useCallback((overlayId: string | null) => {
    // 既存のオーバーレイロックを解放
    if (selectedOverlayId && selectedOverlayId !== overlayId) {
      releaseLock([selectedOverlayId]);
    }
    // 新しいオーバーレイをロック取得
    if (overlayId) {
      const result = acquireLock([overlayId]);
      if (result.granted.length === 0) {
        // ロック取得失敗 — 選択しない
        setSelectedOverlayId(null);
        return;
      }
    }
    setSelectedOverlayId(overlayId);
  }, [selectedOverlayId, setSelectedOverlayId, acquireLock, releaseLock]);

  // ========================================
  // Object Lock: 投げ縄選択時のロック取得（部分選択）
  // ========================================
  const handleLassoSelectionChange = useCallback((sel: LassoSelection | null) => {
    // 前の選択のロックを解放
    if (lassoSelection) {
      const prevIds = [...lassoSelection.strokeIds, ...lassoSelection.overlayIds];
      if (prevIds.length > 0) releaseLock(prevIds);
    }

    if (!sel) {
      setLassoSelection(null);
      return;
    }

    // ロック取得を試行
    const targetIds = [...sel.strokeIds, ...sel.overlayIds];
    if (targetIds.length === 0) {
      setLassoSelection(sel);
      return;
    }

    const result = acquireLock(targetIds);
    if (result.denied.length === 0) {
      // 全て取得成功
      setLassoSelection(sel);
    } else {
      // 部分選択: denied な ID を除外
      const deniedSet = new Set(result.denied.map(d => d.id));
      const filteredStrokeIds = new Set([...sel.strokeIds].filter(id => !deniedSet.has(id)));
      const filteredOverlayIds = new Set([...sel.overlayIds].filter(id => !deniedSet.has(id)));
      if (filteredStrokeIds.size === 0 && filteredOverlayIds.size === 0) {
        setLassoSelection(null);
      } else {
        setLassoSelection({ strokeIds: filteredStrokeIds, overlayIds: filteredOverlayIds });
      }
    }

    // pendingLassoSelection が消費されたらクリア
    if (pendingLassoSelection) setPendingLassoSelection(null);
  }, [lassoSelection, pendingLassoSelection, acquireLock, releaseLock]);

  // ========================================
  // 投げ縄アクション
  // ========================================

  /** 投げ縄 BBox (canvas 座標系) */
  const lassoCanvasBBox = useMemo((): [number, number, number, number] | null => {
    if (!lassoSelection) return null;
    return computeLassoBBox(activeStrokes, activeOverlays, lassoSelection.strokeIds, lassoSelection.overlayIds);
  }, [lassoSelection, activeStrokes, activeOverlays]);

  /** 選択されたストロークとオーバーレイのデータを取得 */
  const getLassoSelectedData = useCallback(() => {
    if (!lassoSelection) return { strokes: [] as DrawEvent[], overlays: [] as OverlayState[] };
    const strokes = activeStrokes.filter(s => lassoSelection.strokeIds.has(s.id));
    const overlays = activeOverlays.filter(o => lassoSelection.overlayIds.has(o.overlayId));
    return { strokes, overlays };
  }, [lassoSelection, activeStrokes, activeOverlays]);

  /** コピー */
  const handleLassoCopy = useCallback(() => {
    const { strokes, overlays } = getLassoSelectedData();
    if (strokes.length === 0 && overlays.length === 0) return;
    if (!lassoCanvasBBox) return;
    setLassoClipboard({ strokes, overlays, canvasBBox: lassoCanvasBBox });
  }, [getLassoSelectedData, lassoCanvasBBox]);

  /** 複製: ビューポートの左上にペースト */
  const handleLassoDuplicate = useCallback(() => {
    const { strokes, overlays } = getLassoSelectedData();
    if (strokes.length === 0 && overlays.length === 0) return;
    if (!lassoCanvasBBox) return;
    // ビューポート左上角(canvas座標系)
    const vpLeft = -canvasTransformFull.x / canvasTransformFull.scale;
    const vpTop = -canvasTransformFull.y / canvasTransformFull.scale;
    const dx = vpLeft - lassoCanvasBBox[0];
    const dy = vpTop - lassoCanvasBBox[1];
    const result = lassoDuplicateSelection(strokes, overlays, dx, dy);
    // 複製した要素を選択状態にする（WhiteboardCanvas に伝達）
    setPendingLassoSelection({
      strokeIds: new Set(result.newStrokeIds),
      overlayIds: new Set(result.newOverlayIds),
    });
  }, [getLassoSelectedData, lassoCanvasBBox, canvasTransformFull, lassoDuplicateSelection]);

  /** 削除 */
  const handleLassoDelete = useCallback(() => {
    const { strokes, overlays } = getLassoSelectedData();
    if (strokes.length === 0 && overlays.length === 0) return;
    lassoDeleteSelection(strokes, overlays.map(o => o.overlayId));
    // ロック解放
    const targetIds = [...strokes.map(s => s.id), ...overlays.map(o => o.overlayId)];
    releaseLock(targetIds);
    setLassoSelection(null);
  }, [getLassoSelectedData, lassoDeleteSelection, releaseLock]);

  /** 貼り付け (Ctrl+V) */
  const handleLassoPaste = useCallback(() => {
    if (!lassoClipboard) return;
    // ビューポート左上角(canvas座標系)
    const vpLeft = -canvasTransformFull.x / canvasTransformFull.scale;
    const vpTop = -canvasTransformFull.y / canvasTransformFull.scale;
    const dx = vpLeft - lassoClipboard.canvasBBox[0];
    const dy = vpTop - lassoClipboard.canvasBBox[1];
    const result = lassoPasteSelection(lassoClipboard.strokes, lassoClipboard.overlays, dx, dy);
    // 貼り付けた要素を選択状態にする（WhiteboardCanvas に伝達）
    setPendingLassoSelection({
      strokeIds: new Set(result.newStrokeIds),
      overlayIds: new Set(result.newOverlayIds),
    });
  }, [lassoClipboard, canvasTransformFull, lassoPasteSelection]);

  // Ctrl+C / Ctrl+V / Delete / Escape / Ctrl+S は useKeyboard に統合済み


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
  // 永続化・エクスポート（hooks/usePersistence.ts に委譲）
  // ========================================
  const {
    handleBack,
    handleCopyShareLink,
    handleExportWbelx,
    handleExportSnapshot,
    handleExportPng,
    handleExportSvg,
  } = usePersistence({
    isHost,
    boardId,
    boardName: boardInfo?.name,
    sessionId,
    roomId,
    events,
    state,
    activeStrokes,
    activeOverlays,
    overlayImages,
    background: project?.config.background,
    canvasSize,
    guestsPresent,
    isJoiningViaShareLink,
    navigate,
    exportWbelx,
    exportSnapshotWbelx,
    regenerateThumbnail,
  });

  // 背景変更ハンドラ（hooks/useBackground.ts に委譲）
  const { handleBackgroundChange } = useBackground({
    currentBackground: project?.config.background,
    sessionId,
    appendEvent,
    pushOp,
    updateBackground,
  });

  // キーボードショートカット（hooks/useKeyboard.ts に一元管理）
  useKeyboard({
    performUndo,
    performRedo,
    setTool: handleSetTool,
    setStrokeWidthKey,
    onSave: handleBack,
    onCopy: lassoSelection ? handleLassoCopy : undefined,
    onPaste: lassoClipboard ? handleLassoPaste : undefined,
    onDelete: lassoSelection ? handleLassoDelete : (selectedOverlayId ? handleInlineDelete : undefined),
    onEscape: () => {
      if (viewportEditorOverlayId) {
        setViewportEditorOverlayId(null);
      } else if (selectedOverlayId) {
        releaseLock([selectedOverlayId]);
        setSelectedOverlayId(null);
      } else if (lassoSelection) {
        setLassoSelection(null);
      }
    },
  });

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
        onToolChange={handleSetTool}
        onColorChange={setColor}
        onStrokeWidthChange={setStrokeWidthKey}
        onUndo={performUndo}
        onRedo={performRedo}
        onCopyShareLink={handleCopyShareLink}
        onExportWbelx={handleExportWbelx}
        onExportSnapshot={handleExportSnapshot}
        onExportPng={handleExportPng}
        onExportSvg={handleExportSvg}
        onAddAsset={handleAddAsset}
        onImportFile={importAsset}
        availableAssets={availableAssets}
        canvasSize={canvasSize}
        onCanvasSizeChange={isHost && boardId ? (w, h) => {
          const newW = w ?? 0;
          const newH = h ?? 0;
          const dW = newW - state.canvasWidth;
          const dH = newH - state.canvasHeight;
          if (dW !== 0 || dH !== 0) {
            const csEvent = {
              type: 'CS' as const,
              timestamp: getTimestamp(),
              sessionId,
              id: generateCsOpId(),
              ...(dW !== 0 && { dCanvasWidth: dW }),
              ...(dH !== 0 && { dCanvasHeight: dH }),
            };
            appendEvent(csEvent);
            pushOp({
              type: 'canvasSize' as const, id: csEvent.id,
              ...(dW !== 0 && { dCanvasWidth: dW }),
              ...(dH !== 0 && { dCanvasHeight: dH }),
            });
            // プロジェクトストアにも反映（永続化用）
            setBoardCanvasSize(boardId, newW, newH);
          }
        } : undefined}
        backgroundConfig={project?.config.background}
        onBackgroundChange={isHost ? handleBackgroundChange : undefined}
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
          overlayDisplayStates={overlayDisplayStates}
          overlayAssetTypes={overlayAssetTypes}
          overlayOpacityOverrides={overlayOpacityOverrides}
          overlayLockAspectRatios={overlayLockAspectRatios}
          backgroundConfig={project?.config.background}
          canvasSize={canvasSize}
          onAddDrawEvent={handleAddDrawEvent}
          onEraseStrokes={handleEraseStrokes}
          onRemoveOverlay={handleRemoveOverlay}
          onTransformOverlay={handleTransformOverlay}
          onSelectOverlay={handleSelectOverlay}
          onDoubleClickOverlay={(overlayId) => setViewportEditorOverlayId(overlayId)}
          onUpdateCursor={updateCursor}
          onHideCursor={hideCursor}
          onTransformChange={handleTransformChange}
          onLassoSelectionChange={handleLassoSelectionChange}
          onLassoMove={lassoMoveSelection}
          onLassoDelete={(strokes, overlayIds) => {
            lassoDeleteSelection(strokes, overlayIds);
            const targetIds = [...strokes.map((s: DrawEvent) => s.id), ...overlayIds];
            releaseLock(targetIds);
            setLassoSelection(null);
          }}
          externalLassoSelection={pendingLassoSelection}
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

        {/* 投げ縄選択中: アクションバー */}
        {lassoSelection && lassoCanvasBBox && tool === 'lasso' && (
          <LassoActionBar
            canvasBBox={lassoCanvasBBox}
            canvasTransform={canvasTransformFull}
            onCopy={handleLassoCopy}
            onDuplicate={handleLassoDuplicate}
            onDelete={handleLassoDelete}
          />
        )}
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