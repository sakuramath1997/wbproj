/**
 * hooks/useLassoOps.ts — 投げ縄操作 Shell フック (L3)
 *
 * core/lasso-engine.ts の純粋関数を呼び出し、
 * 結果を Yjs に追加 + Undo スタックに登録するグルーコード。
 *
 * Phase 3b で useYjsSync から分離。
 *
 * 責務:
 *   - lassoMoveSelection / lassoDeleteSelection / lassoDuplicateSelection / lassoPasteSelection
 *   - core/lasso-engine.ts を内部使用
 *   - lassoSelection / lassoClipboard の React 状態管理は BoardEditor に残す（UI 表示に直結）
 */

import { useCallback } from 'react';
import type {
  WbelxEvent,
  WbelxState,
  DrawEvent,
  OverlayState,
  BatchEvent,
  Operation,
} from '../types';
import {
  buildLassoMoveData,
  buildLassoDeleteData,
  buildLassoCreateData,
} from '../core/lasso-engine';
import {
  getTimestamp,
  generateEraseId, generateRemoveId, generateTransformOpId,
  generateStrokeId, generateOverlayId, generateBatchId,
} from '../utils/common';

// ========================================
// 型定義
// ========================================

export interface UseLassoOpsOptions {
  /** セッション ID */
  sessionId: string;
  /** 現在のステートマシン状態（overlay 情報, maxZIndex 計算用） */
  stateRef: React.RefObject<WbelxState>;
  /** Yjs にイベントを追加 */
  pushEvent: (event: WbelxEvent) => void;
  /** Undo スタックに Operation を追加 */
  pushOp: (op: Operation) => void;
}

export interface UseLassoOpsReturn {
  /** 投げ縄移動 */
  lassoMoveSelection: (
    originalStrokes: DrawEvent[],
    movedStrokes: DrawEvent[],
    overlayDeltas: Array<{ overlayId: string; dx: number; dy: number }>,
  ) => void;
  /** 投げ縄削除 */
  lassoDeleteSelection: (strokes: DrawEvent[], overlayIds: string[]) => void;
  /** 投げ縄複製 */
  lassoDuplicateSelection: (
    strokes: DrawEvent[], overlays: OverlayState[],
    dx: number, dy: number,
  ) => { newStrokeIds: string[]; newOverlayIds: string[] };
  /** 投げ縄貼り付け */
  lassoPasteSelection: (
    strokes: DrawEvent[], overlays: OverlayState[],
    dx: number, dy: number,
  ) => { newStrokeIds: string[]; newOverlayIds: string[] };
}

// ========================================
// ヘルパー
// ========================================

const moveIdGen = { generateEraseId, generateTransformOpId };
const deleteIdGen = { generateEraseId, generateRemoveId };
const createIdGen = { generateStrokeId, generateOverlayId };

/**
 * subEvents + ops を Yjs に追加 + Undo スタックに登録する。
 * 1 件なら単体、2+ 件なら BATCH。
 */
function emitEvents(
  subEvents: import('../types').SubEvent[],
  ops: import('../types').SingleOperation[],
  ts: string,
  sid: string,
  pushEvent: (event: WbelxEvent) => void,
  pushOp: (op: Operation) => void,
): void {
  if (subEvents.length === 0) return;
  if (subEvents.length === 1) {
    pushEvent(subEvents[0] as WbelxEvent);
    pushOp(ops[0]);
  } else {
    const batch: BatchEvent = {
      type: 'BATCH', id: generateBatchId(), timestamp: ts, sessionId: sid, events: subEvents,
    };
    pushEvent(batch);
    pushOp({ type: 'batch', batchId: batch.id, operations: ops });
  }
}

// ========================================
// フック本体
// ========================================

export function useLassoOps({
  sessionId,
  stateRef,
  pushEvent,
  pushOp,
}: UseLassoOpsOptions): UseLassoOpsReturn {

  const lassoMoveSelection = useCallback((
    originalStrokes: DrawEvent[],
    movedStrokes: DrawEvent[],
    overlayDeltas: Array<{ overlayId: string; dx: number; dy: number }>,
  ) => {
    if (originalStrokes.length === 0 && overlayDeltas.length === 0) return;
    const ts = getTimestamp();
    const { subEvents, ops } = buildLassoMoveData(
      originalStrokes, movedStrokes, overlayDeltas, ts, sessionId, moveIdGen,
    );
    emitEvents(subEvents, ops, ts, sessionId, pushEvent, pushOp);
  }, [sessionId, pushEvent, pushOp]);

  const lassoDeleteSelection = useCallback((strokes: DrawEvent[], overlayIds: string[]) => {
    if (strokes.length === 0 && overlayIds.length === 0) return;
    const ts = getTimestamp();
    const s = stateRef.current;
    if (!s) return;
    const { subEvents, ops } = buildLassoDeleteData(
      strokes, overlayIds, s.overlays, ts, sessionId, deleteIdGen,
    );
    emitEvents(subEvents, ops, ts, sessionId, pushEvent, pushOp);
  }, [sessionId, stateRef, pushEvent, pushOp]);

  const lassoCreateSelection = useCallback((
    strokes: DrawEvent[], overlays: OverlayState[],
    dx: number, dy: number,
  ): { newStrokeIds: string[]; newOverlayIds: string[] } => {
    const ts = getTimestamp();
    const s = stateRef.current;
    if (!s) return { newStrokeIds: [], newOverlayIds: [] };
    // 現在の最大 zIndex を計算
    let maxZ = 0;
    for (const [, ov] of s.overlays) {
      if (s.activeOverlayIds.has(ov.overlayId) && ov.zIndex > maxZ) maxZ = ov.zIndex;
    }
    const { subEvents, ops, newStrokeIds, newOverlayIds } = buildLassoCreateData(
      strokes, overlays, dx, dy, maxZ, ts, sessionId, createIdGen,
    );
    emitEvents(subEvents, ops, ts, sessionId, pushEvent, pushOp);
    return { newStrokeIds, newOverlayIds };
  }, [sessionId, stateRef, pushEvent, pushOp]);

  const lassoDuplicateSelection = useCallback((
    strokes: DrawEvent[], overlays: OverlayState[],
    dx: number, dy: number,
  ) => {
    return lassoCreateSelection(strokes, overlays, dx, dy);
  }, [lassoCreateSelection]);

  const lassoPasteSelection = useCallback((
    strokes: DrawEvent[], overlays: OverlayState[],
    dx: number, dy: number,
  ) => {
    return lassoCreateSelection(strokes, overlays, dx, dy);
  }, [lassoCreateSelection]);

  return {
    lassoMoveSelection,
    lassoDeleteSelection,
    lassoDuplicateSelection,
    lassoPasteSelection,
  };
}
