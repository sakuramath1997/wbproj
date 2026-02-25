/**
 * hooks/useOverlayOps.ts — オーバーレイ操作（L3 Shell）
 *
 * 移動元: BoardEditor.tsx の handleAddAsset, handleRemoveOverlay,
 *         handleApplyViewport, z-index 操作, handleOpacityCommit,
 *         handleInlinePageChange, handleInlineDelete
 *
 * 内部管理: selectedOverlayId, viewportEditorOverlayId, 関連派生状態
 * Core 層: core/overlay-ops.ts (z-index 計算, ビューポート再計算)
 *
 * Phase 3c: appendEvent + pushOp パターンに移行。
 *   イベント構築を内部で行い、appendEvent で Yjs に追加、pushOp で Undo 登録。
 */

import { useState, useCallback, useMemo } from 'react';
import type {
  WbelxEvent,
  OverlayAddEvent,
  OverlayRemoveEvent,
  OverlayTransformEvent,
  OverlayViewportEvent,
  OverlayStyleEvent,
  BatchEvent,
  SubEvent,
  SingleOperation,
  OverlayState,
  AssetType,
  AssetIndex,
  Operation,
  ViewportDelta,
} from '../types';
import type { BoardInfo } from '../types/project';
import type { Project } from '../utils/project';
import type { OverlayDisplayState } from '../types/overlay-display';
import {
  getTimestamp,
  generateRemoveId, generateTransformOpId, generateViewportOpId,
  generateStyleOpId, generateBatchId,
} from '../utils/common';
import { loadPdfDocument } from '../utils/pdf';
import { loadBoardSnapshot, loadAssetFileAsDataUrl } from '../utils/storage';
import { computeState, getActiveStrokes, getActiveOverlays } from '../core/state-machine';
import {
  sortOverlaysByZIndex,
  computeBringToFront,
  computeBringForward,
  computeSendBackward,
  computeSendToBack,
  computeBoardViewportTransform,
} from '../core/overlay-ops';

// ========================================
// 型定義
// ========================================

export interface UseOverlayOpsOptions {
  sessionId: string;
  activeOverlays: OverlayState[];
  localBoardUuid: string | undefined;
  /** プロジェクト設定 */
  project: Project | null;
  /** ゲストの場合のアセットインデックス */
  guestAssetIndex: AssetIndex | null;
  /** イベントを Yjs に追加 */
  appendEvent: (event: WbelxEvent) => void;
  /** Undo スタックに操作を追加 */
  pushOp: (op: Operation) => void;
  // ProjectStore コールバック
  onAssetAddedToBoard: (boardUuid: string, assetUuid: string) => void;
  onAssetRemovedFromBoard: (boardUuid: string, assetUuid: string) => void;
  getBoards: () => BoardInfo[];
  getBoardUuid: (boardId: string) => string | undefined;
  loadBoardEventsAsync: (boardId: string) => Promise<WbelxEvent[]>;
  // Display 状態コールバック（Phase 2c の useOverlayDisplay が所有する状態への参照）
  overlayRenderKeyRef: React.MutableRefObject<Map<string, string>>;
  setOverlayDisplayStates: React.Dispatch<React.SetStateAction<Map<string, OverlayDisplayState>>>;
  setOverlayOpacityOverrides: React.Dispatch<React.SetStateAction<Map<string, number>>>;
  setOverlayLockAspectRatios: React.Dispatch<React.SetStateAction<Map<string, boolean>>>;
}

export interface UseOverlayOpsReturn {
  selectedOverlayId: string | null;
  setSelectedOverlayId: (id: string | null) => void;
  viewportEditorOverlayId: string | null;
  setViewportEditorOverlayId: (id: string | null) => void;
  selectedOverlay: OverlayState | null;
  selectedOverlayAssetType: AssetType;
  viewportEditorOverlay: OverlayState | null;
  viewportEditorAssetType: AssetType;
  viewportEditorAssetName: string;
  sortedOverlays: OverlayState[];
  handleAddAsset: (assetUuid: string) => Promise<void>;
  handleRemoveOverlay: (overlayId: string) => void;
  handleCloseViewportEditor: () => void;
  handleApplyViewport: (
    viewport: { x: number; y: number; width: number; height: number },
    page: number,
    newAssetUuid?: string,
    overlayTransform?: { x: number; y: number; width: number; height: number },
    naturalSize?: { width: number; height: number },
    lockAspectRatio?: boolean,
    initialBoardViewport?: { x: number; y: number; width: number; height: number },
  ) => void;
  handleOpacityCommit: (opacity: number) => void;
  handleBringToFront: () => void;
  handleBringForward: () => void;
  handleSendBackward: () => void;
  handleSendToBack: () => void;
  handleInlinePageChange: (page: number) => void;
  handleInlineDelete: () => void;
}

export function useOverlayOps({
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
}: UseOverlayOpsOptions): UseOverlayOpsReturn {
  // ========================================
  // 内部状態
  // ========================================
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  const [viewportEditorOverlayId, setViewportEditorOverlayId] = useState<string | null>(null);

  const resolvedAssetIndex = project?.assetIndex ?? guestAssetIndex;

  // ========================================
  // 内部ヘルパー: イベント構築 + appendEvent + pushOp
  // ========================================

  /** OA イベントを発行 */
  const emitAddOverlay = useCallback((event: OverlayAddEvent) => {
    const e = { ...event, sessionId: event.sessionId || sessionId };
    appendEvent(e);
    pushOp({ type: 'overlayAdd', overlayId: e.overlayId, overlayData: e });
  }, [sessionId, appendEvent, pushOp]);

  /** OR イベントを発行 */
  const emitRemoveOverlay = useCallback((overlayId: string) => {
    const overlay = activeOverlays.find(o => o.overlayId === overlayId);
    if (!overlay) return;
    const targetOverlay: OverlayAddEvent = {
      type: 'OA', timestamp: '', sessionId: '',
      overlayId: overlay.overlayId, assetUuid: overlay.assetUuid,
      x: overlay.x, y: overlay.y, width: overlay.width, height: overlay.height,
      rotation: overlay.rotation, viewport: overlay.viewport,
      page: overlay.page, zIndex: overlay.zIndex, opacity: overlay.opacity,
    };
    const removeId = generateRemoveId();
    const e: OverlayRemoveEvent = {
      type: 'OR', timestamp: getTimestamp(), sessionId,
      removeId, targetOverlayId: overlayId,
    };
    appendEvent(e);
    pushOp({ type: 'overlayRemove', removeId, targetOverlayId: overlayId, targetOverlay });
  }, [activeOverlays, sessionId, appendEvent, pushOp]);

  /** OT イベントを発行 */
  const emitTransformOverlay = useCallback((
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

  /** OV イベントを発行 */
  const emitViewportOverlay = useCallback((
    overlayId: string,
    before: { viewport: { x: number; y: number; width: number; height: number }; page: number },
    after: { viewport: { x: number; y: number; width: number; height: number }; page: number },
  ) => {
    const opId = generateViewportOpId();
    const dvp: ViewportDelta = {};
    const dxVp = after.viewport.x - before.viewport.x;
    const dyVp = after.viewport.y - before.viewport.y;
    const dwVp = after.viewport.width - before.viewport.width;
    const dhVp = after.viewport.height - before.viewport.height;
    if (dxVp !== 0) dvp.dx = dxVp;
    if (dyVp !== 0) dvp.dy = dyVp;
    if (dwVp !== 0) dvp.dWidth = dwVp;
    if (dhVp !== 0) dvp.dHeight = dhVp;
    const hasVpDelta = Object.keys(dvp).length > 0;
    const dPage = after.page - before.page;
    const e: OverlayViewportEvent = {
      type: 'OV', timestamp: getTimestamp(), sessionId, id: opId, overlayId,
      ...(hasVpDelta && { dViewport: dvp }),
      ...(dPage !== 0 && { dPage }),
    };
    appendEvent(e);
    pushOp({
      type: 'overlayViewport', id: opId, overlayId,
      ...(hasVpDelta && { dViewport: dvp }),
      ...(dPage !== 0 && { dPage }),
    });
  }, [sessionId, appendEvent, pushOp]);

  /** OS スタイル変更。1 ターゲットなら単独 OS、2+ なら BATCH。 */
  const emitStyleOverlays = useCallback((
    targets: Array<{ overlayId: string; before: { zIndex: number; opacity: number }; after: { zIndex: number; opacity: number } }>,
  ) => {
    if (targets.length === 0) return;
    const ts = getTimestamp();

    if (targets.length === 1) {
      const t = targets[0];
      const dzIndex = t.after.zIndex - t.before.zIndex;
      const dOpacity = t.after.opacity - t.before.opacity;
      const opId = generateStyleOpId();
      const e: OverlayStyleEvent = {
        type: 'OS', timestamp: ts, sessionId, id: opId, overlayId: t.overlayId,
        ...(dzIndex !== 0 && { dzIndex }),
        ...(Math.abs(dOpacity) > 1e-9 && { dOpacity }),
      };
      appendEvent(e);
      pushOp({
        type: 'overlayStyle', id: opId, overlayId: t.overlayId,
        ...(dzIndex !== 0 && { dzIndex }),
        ...(Math.abs(dOpacity) > 1e-9 && { dOpacity }),
      });
    } else {
      const subEvents: SubEvent[] = [];
      const ops: SingleOperation[] = [];
      for (const t of targets) {
        const dzIndex = t.after.zIndex - t.before.zIndex;
        const dOpacity = t.after.opacity - t.before.opacity;
        const opId = generateStyleOpId();
        subEvents.push({
          type: 'OS', timestamp: ts, sessionId, id: opId, overlayId: t.overlayId,
          ...(dzIndex !== 0 && { dzIndex }),
          ...(Math.abs(dOpacity) > 1e-9 && { dOpacity }),
        } as OverlayStyleEvent);
        ops.push({
          type: 'overlayStyle', id: opId, overlayId: t.overlayId,
          ...(dzIndex !== 0 && { dzIndex }),
          ...(Math.abs(dOpacity) > 1e-9 && { dOpacity }),
        });
      }
      const batch: BatchEvent = { type: 'BATCH', id: generateBatchId(), timestamp: ts, sessionId, events: subEvents };
      appendEvent(batch);
      pushOp({ type: 'batch', batchId: batch.id, operations: ops });
    }
  }, [sessionId, appendEvent, pushOp]);

  // ========================================
  // 派生状態
  // ========================================
  const viewportEditorOverlay = useMemo(() => {
    if (!viewportEditorOverlayId) return null;
    return activeOverlays.find(o => o.overlayId === viewportEditorOverlayId) || null;
  }, [viewportEditorOverlayId, activeOverlays]);

  const selectedOverlay = useMemo(() => {
    if (!selectedOverlayId) return null;
    return activeOverlays.find(o => o.overlayId === selectedOverlayId) || null;
  }, [selectedOverlayId, activeOverlays]);

  const selectedOverlayAssetType = useMemo((): AssetType => {
    if (!selectedOverlay || !project) return 'image';
    return project.assetIndex.byUuid.get(selectedOverlay.assetUuid)?.type as AssetType ?? 'image';
  }, [selectedOverlay, project]);

  const sortedOverlays = useMemo(
    () => sortOverlaysByZIndex(activeOverlays),
    [activeOverlays]
  );

  // ========================================
  // handleAddAsset
  // ========================================
  const handleAddAsset = useCallback(async (assetUuid: string) => {
    const assetType = resolvedAssetIndex?.byUuid.get(assetUuid)?.type as AssetType | undefined;

    const DEFAULT_W = 300;
    const DEFAULT_H = 200;
    const DEFAULT_CX = 250;
    const DEFAULT_CY = 200;
    const DEFAULT_AREA = DEFAULT_W * DEFAULT_H;

    const margin = project?.config.rendering.boardOverlayMargin ?? 50;
    const fallback = project?.config.rendering.boardOverlayFallbackViewport
      ?? { x: -960, y: -540, width: 1920, height: 1080 };

    let width = DEFAULT_W;
    let height = DEFAULT_H;
    let overlayViewport = { x: 0, y: 0, width: 0, height: 0 };

    if (assetType === 'document') {
      try {
        const dataUrl = await loadAssetFileAsDataUrl(assetUuid);
        if (dataUrl) {
          const pdfDoc = await loadPdfDocument(dataUrl);
          const page = await pdfDoc.getPage(1);
          const vp = page.getViewport({ scale: 1 });
          const ar = vp.width / vp.height;
          width = Math.round(Math.sqrt(DEFAULT_AREA * ar));
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
            overlayViewport = {
              x: minX - margin,
              y: minY - margin,
              width: maxX - minX + margin * 2,
              height: maxY - minY + margin * 2,
            };
          } else {
            overlayViewport = { ...fallback };
          }

          const ar = overlayViewport.width / overlayViewport.height;
          width = Math.round(Math.sqrt(DEFAULT_AREA * ar));
          height = Math.round(Math.sqrt(DEFAULT_AREA / ar));
        }
      } catch (error) {
        console.warn('Failed to get board dimensions:', error);
      }
    }

    const x = Math.round(DEFAULT_CX - width / 2);
    const y = Math.round(DEFAULT_CY - height / 2);

    const event: OverlayAddEvent = {
      type: 'OA',
      timestamp: getTimestamp(),
      sessionId,
      overlayId: `o:${Date.now().toString(36)}`,
      assetUuid,
      x, y, width, height,
      rotation: 0,
      viewport: overlayViewport,
      page: 1,
      zIndex: activeOverlays.length + 1,
      opacity: 1.0,
    };
    emitAddOverlay(event);

    if (localBoardUuid) {
      onAssetAddedToBoard(localBoardUuid, assetUuid);
    }
  }, [sessionId, activeOverlays.length, emitAddOverlay, localBoardUuid, onAssetAddedToBoard, project, getBoards, getBoardUuid, loadBoardEventsAsync, resolvedAssetIndex]);

  // ========================================
  // handleRemoveOverlay
  // ========================================
  const handleRemoveOverlay = useCallback((overlayId: string) => {
    const overlay = activeOverlays.find(o => o.overlayId === overlayId);
    if (!overlay) return;
    emitRemoveOverlay(overlayId);

    if (localBoardUuid) {
      const otherOverlays = activeOverlays.filter(
        o => o.assetUuid === overlay.assetUuid && o.overlayId !== overlayId
      );
      if (otherOverlays.length === 0) {
        onAssetRemovedFromBoard(localBoardUuid, overlay.assetUuid);
      }
    }
  }, [activeOverlays, emitRemoveOverlay, localBoardUuid, onAssetRemovedFromBoard]);

  // ========================================
  // ViewportEditor
  // ========================================
  const handleCloseViewportEditor = useCallback(() => {
    setViewportEditorOverlayId(null);
    setSelectedOverlayId(null);
  }, []);

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
      // アセット変更の場合: OR + OA
      emitRemoveOverlay(overlay.overlayId);

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
        x: newX, y: newY, width: newWidth, height: newHeight,
        rotation: overlay.rotation,
        viewport, page,
        zIndex: overlay.zIndex,
        opacity: overlay.opacity,
      };
      emitAddOverlay(addEvent);

      if (localBoardUuid) {
        onAssetRemovedFromBoard(localBoardUuid, overlay.assetUuid);
        onAssetAddedToBoard(localBoardUuid, newAssetUuid);
      }
    } else {
      // アセット変更なし — board overlay の viewport 再計算
      let finalOverlayTransform = overlayTransform;

      const assetType = resolvedAssetIndex?.byUuid.get(overlay.assetUuid)?.type;
      if (assetType === 'board') {
        const vpOld =
          (initialBoardViewport && initialBoardViewport.width > 0)
            ? initialBoardViewport
            : (overlay.viewport.width > 0 && overlay.viewport.height > 0)
              ? overlay.viewport
              : { x: -960, y: -540, width: 1920, height: 1080 };

        const result = computeBoardViewportTransform(overlay, vpOld, viewport);
        if (result) {
          finalOverlayTransform = result;
        }
      }

      if (finalOverlayTransform) {
        emitTransformOverlay(
          overlay.overlayId,
          { x: overlay.x, y: overlay.y, width: overlay.width, height: overlay.height, rotation: overlay.rotation },
          { x: finalOverlayTransform.x, y: finalOverlayTransform.y, width: finalOverlayTransform.width, height: finalOverlayTransform.height, rotation: overlay.rotation },
        );
      }

      emitViewportOverlay(
        overlay.overlayId,
        { viewport: overlay.viewport, page: overlay.page },
        { viewport, page },
      );
    }

    setViewportEditorOverlayId(null);
    // renderKey キャッシュを削除
    overlayRenderKeyRef.current.delete(overlay.overlayId);
    // ローディング表示を開始
    setOverlayDisplayStates((prev) => {
      const next = new Map(prev);
      const prevState = prev.get(overlay.overlayId);
      next.set(overlay.overlayId, { status: 'loading', image: prevState?.image ?? null });
      return next;
    });
    // AR ロック設定を保存
    if (lockAspectRatio !== undefined && overlay.overlayId) {
      setOverlayLockAspectRatios((prev: Map<string, boolean>) => new Map([...prev, [overlay.overlayId, lockAspectRatio]]));
    }
    setSelectedOverlayId(null);
  }, [activeOverlays, viewportEditorOverlayId, sessionId, emitRemoveOverlay, emitAddOverlay, emitTransformOverlay, emitViewportOverlay, localBoardUuid, onAssetRemovedFromBoard, onAssetAddedToBoard, resolvedAssetIndex, overlayRenderKeyRef, setOverlayDisplayStates, setOverlayLockAspectRatios]);

  // ========================================
  // Opacity / z-index
  // ========================================
  const handleOpacityCommit = useCallback((opacity: number) => {
    if (!selectedOverlay) return;
    emitStyleOverlays([{
      overlayId: selectedOverlay.overlayId,
      before: { zIndex: selectedOverlay.zIndex, opacity: selectedOverlay.opacity },
      after: { zIndex: selectedOverlay.zIndex, opacity },
    }]);
    setOverlayOpacityOverrides(new Map());
  }, [selectedOverlay, emitStyleOverlays, setOverlayOpacityOverrides]);

  const handleBringToFront = useCallback(() => {
    if (!selectedOverlay) return;
    const targets = computeBringToFront(selectedOverlay, activeOverlays);
    if (targets) emitStyleOverlays(targets);
  }, [activeOverlays, selectedOverlay, emitStyleOverlays]);

  const handleBringForward = useCallback(() => {
    if (!selectedOverlay) return;
    const targets = computeBringForward(selectedOverlay, activeOverlays);
    if (targets) emitStyleOverlays(targets);
  }, [selectedOverlay, activeOverlays, emitStyleOverlays]);

  const handleSendBackward = useCallback(() => {
    if (!selectedOverlay) return;
    const targets = computeSendBackward(selectedOverlay, activeOverlays);
    if (targets) emitStyleOverlays(targets);
  }, [selectedOverlay, activeOverlays, emitStyleOverlays]);

  const handleSendToBack = useCallback(() => {
    if (!selectedOverlay) return;
    const targets = computeSendToBack(selectedOverlay, activeOverlays);
    if (targets) emitStyleOverlays(targets);
  }, [activeOverlays, selectedOverlay, emitStyleOverlays]);

  // ========================================
  // Inline controls
  // ========================================
  const handleInlinePageChange = useCallback((page: number) => {
    if (!selectedOverlay) return;
    emitViewportOverlay(
      selectedOverlay.overlayId,
      { viewport: selectedOverlay.viewport, page: selectedOverlay.page },
      { viewport: selectedOverlay.viewport, page },
    );
  }, [selectedOverlay, emitViewportOverlay]);

  const handleInlineDelete = useCallback(() => {
    if (!selectedOverlayId) return;
    const overlay = activeOverlays.find(o => o.overlayId === selectedOverlayId);
    if (!overlay) return;
    emitRemoveOverlay(selectedOverlayId);
    setSelectedOverlayId(null);
    if (localBoardUuid) onAssetRemovedFromBoard(localBoardUuid, overlay.assetUuid);
  }, [selectedOverlayId, activeOverlays, emitRemoveOverlay, localBoardUuid, onAssetRemovedFromBoard]);

  // ViewportEditor 用のアセット情報
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

  return {
    selectedOverlayId,
    setSelectedOverlayId,
    viewportEditorOverlayId,
    setViewportEditorOverlayId,
    selectedOverlay,
    selectedOverlayAssetType,
    viewportEditorOverlay,
    viewportEditorAssetType,
    viewportEditorAssetName,
    sortedOverlays,
    handleAddAsset,
    handleRemoveOverlay,
    handleCloseViewportEditor,
    handleApplyViewport,
    handleOpacityCommit,
    handleBringToFront,
    handleBringForward,
    handleSendBackward,
    handleSendToBack,
    handleInlinePageChange,
    handleInlineDelete,
  };
}