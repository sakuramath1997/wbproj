/**
 * core/lasso-engine.ts — 投げ縄操作エンジン（Rust 移植対象）
 *
 * React 非依存。ブラウザ API 非依存。
 *
 * 移動元:
 *   - BoardEditor.tsx: getLassoSelectedData, lassoCanvasBBox 計算
 *   - useYjs.ts: lassoMoveSelection, lassoDeleteSelection, lassoCreateSelection
 *
 * 参照仕様:
 *   application-spec v3 §Lasso Operations:
 *     投げ縄で選択した要素を一括移動する場合、BATCH イベントが生成される。
 *     Lasso 操作は BATCH 単位で Undo される。
 */

import type {
  DrawEvent,
  OverlayState,
  OverlayAddEvent,
  SubEvent,
  SingleOperation,
  BBox,
} from './types';
import { offsetSvgPath, offsetBbox } from './event-builders';

// ========================================
// 型定義
// ========================================

/** 投げ縄で選択されたデータ */
export interface LassoSelectedData {
  strokes: DrawEvent[];
  overlays: OverlayState[];
}

// ========================================
// BBox 計算
// ========================================

/**
 * 選択されたストロークとオーバーレイの外接矩形を計算する。
 * @returns [minX, minY, maxX, maxY] または要素がない場合は null
 */
export function computeLassoBBox(
  activeStrokes: ReadonlyArray<DrawEvent>,
  activeOverlays: ReadonlyArray<OverlayState>,
  selectedStrokeIds: ReadonlySet<string>,
  selectedOverlayIds: ReadonlySet<string>,
): BBox | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const stroke of activeStrokes) {
    if (!selectedStrokeIds.has(stroke.id)) continue;
    if (stroke.bbox) {
      minX = Math.min(minX, stroke.bbox[0]);
      minY = Math.min(minY, stroke.bbox[1]);
      maxX = Math.max(maxX, stroke.bbox[2]);
      maxY = Math.max(maxY, stroke.bbox[3]);
    }
  }

  for (const ov of activeOverlays) {
    if (!selectedOverlayIds.has(ov.overlayId)) continue;
    minX = Math.min(minX, ov.x);
    minY = Math.min(minY, ov.y);
    maxX = Math.max(maxX, ov.x + ov.width);
    maxY = Math.max(maxY, ov.y + ov.height);
  }

  if (minX === Infinity) return null;
  return [minX, minY, maxX, maxY];
}

/**
 * 選択されたストロークとオーバーレイのデータを抽出する。
 */
export function extractLassoSelectedData(
  activeStrokes: ReadonlyArray<DrawEvent>,
  activeOverlays: ReadonlyArray<OverlayState>,
  selectedStrokeIds: ReadonlySet<string>,
  selectedOverlayIds: ReadonlySet<string>,
): LassoSelectedData {
  const strokes = activeStrokes.filter(s => selectedStrokeIds.has(s.id));
  const overlays = activeOverlays.filter(o => selectedOverlayIds.has(o.overlayId));
  return { strokes, overlays };
}

// ========================================
// 移動 BATCH 生成
// ========================================

/**
 * 投げ縄移動の BATCH サブイベント + Operation を生成する。
 *
 * 移動 = 元ストローク消去 + 移動後ストローク追加 + オーバーレイ OT
 */
export function buildLassoMoveData(
  originalStrokes: DrawEvent[],
  movedStrokes: DrawEvent[],
  overlayDeltas: Array<{ overlayId: string; dx: number; dy: number }>,
  timestamp: string,
  sessionId: string,
  idGenerators: {
    generateEraseId: () => string;
    generateTransformOpId: () => string;
  },
): { subEvents: SubEvent[]; ops: SingleOperation[] } {
  const subEvents: SubEvent[] = [];
  const ops: SingleOperation[] = [];

  // 元ストロークを消去
  for (const stroke of originalStrokes) {
    const eid = idGenerators.generateEraseId();
    subEvents.push({ type: 'E', timestamp, sessionId, id: eid, targetId: stroke.id });
    ops.push({ type: 'erase', eraseId: eid, targetId: stroke.id, targetStroke: stroke });
  }

  // 移動後ストロークを追加
  for (const stroke of movedStrokes) {
    const s = { ...stroke, timestamp, sessionId };
    subEvents.push(s);
    ops.push({ type: 'draw', strokeId: s.id, strokeData: s });
  }

  // オーバーレイ移動 (OT)
  for (const { overlayId, dx, dy } of overlayDeltas) {
    const opId = idGenerators.generateTransformOpId();
    subEvents.push({
      type: 'OT', timestamp, sessionId, id: opId, overlayId,
      ...(dx !== 0 && { dx }), ...(dy !== 0 && { dy }),
    });
    ops.push({ type: 'overlayTransform', id: opId, overlayId, dx, dy, dWidth: 0, dHeight: 0, dRotation: 0 });
  }

  return { subEvents, ops };
}

// ========================================
// 削除 BATCH 生成
// ========================================

/**
 * 投げ縄削除の BATCH サブイベント + Operation を生成する。
 */
export function buildLassoDeleteData(
  strokes: DrawEvent[],
  overlayIds: string[],
  overlayStates: ReadonlyMap<string, OverlayState>,
  timestamp: string,
  sessionId: string,
  idGenerators: {
    generateEraseId: () => string;
    generateRemoveId: () => string;
  },
): { subEvents: SubEvent[]; ops: SingleOperation[] } {
  const subEvents: SubEvent[] = [];
  const ops: SingleOperation[] = [];

  // ストローク消去
  for (const stroke of strokes) {
    const eid = idGenerators.generateEraseId();
    subEvents.push({ type: 'E', timestamp, sessionId, id: eid, targetId: stroke.id });
    ops.push({ type: 'erase', eraseId: eid, targetId: stroke.id, targetStroke: stroke });
  }

  // オーバーレイ削除
  for (const overlayId of overlayIds) {
    const overlay = overlayStates.get(overlayId);
    if (!overlay) continue;
    const targetOverlay: OverlayAddEvent = {
      type: 'OA', timestamp: '', sessionId: '',
      overlayId: overlay.overlayId, assetUuid: overlay.assetUuid,
      x: overlay.x, y: overlay.y, width: overlay.width, height: overlay.height,
      rotation: overlay.rotation, viewport: overlay.viewport,
      page: overlay.page, zIndex: overlay.zIndex, opacity: overlay.opacity,
    };
    const rid = idGenerators.generateRemoveId();
    subEvents.push({ type: 'OR', timestamp, sessionId, removeId: rid, targetOverlayId: overlayId });
    ops.push({ type: 'overlayRemove', removeId: rid, targetOverlayId: overlayId, targetOverlay });
  }

  return { subEvents, ops };
}

// ========================================
// 複製/貼り付け BATCH 生成
// ========================================

/**
 * 投げ縄複製（または貼り付け）の BATCH サブイベント + Operation を生成する。
 * ストロークとオーバーレイを dx, dy オフセットして新規作成する。
 *
 * @returns subEvents, ops, 新しいストローク ID 一覧, 新しいオーバーレイ ID 一覧
 */
export function buildLassoCreateData(
  strokes: DrawEvent[],
  overlays: OverlayState[],
  dx: number,
  dy: number,
  currentMaxZIndex: number,
  timestamp: string,
  sessionId: string,
  idGenerators: {
    generateStrokeId: () => string;
    generateOverlayId: () => string;
  },
): { subEvents: SubEvent[]; ops: SingleOperation[]; newStrokeIds: string[]; newOverlayIds: string[] } {
  const subEvents: SubEvent[] = [];
  const ops: SingleOperation[] = [];
  const newStrokeIds: string[] = [];
  const newOverlayIds: string[] = [];

  // ストローク複製
  for (const stroke of strokes) {
    const newId = idGenerators.generateStrokeId();
    newStrokeIds.push(newId);
    const newStroke: DrawEvent = {
      ...stroke,
      id: newId,
      timestamp,
      sessionId,
      path: offsetSvgPath(stroke.path, dx, dy),
      bbox: stroke.bbox ? offsetBbox(stroke.bbox, dx, dy) : stroke.bbox,
    };
    subEvents.push(newStroke);
    ops.push({ type: 'draw', strokeId: newId, strokeData: newStroke });
  }

  // オーバーレイ複製
  let maxZ = currentMaxZIndex;
  for (const overlay of overlays) {
    const newOvId = idGenerators.generateOverlayId();
    newOverlayIds.push(newOvId);
    maxZ++;
    const oaEvent: OverlayAddEvent = {
      type: 'OA', timestamp, sessionId,
      overlayId: newOvId, assetUuid: overlay.assetUuid,
      x: overlay.x + dx, y: overlay.y + dy,
      width: overlay.width, height: overlay.height,
      rotation: overlay.rotation, viewport: { ...overlay.viewport },
      page: overlay.page, zIndex: maxZ, opacity: overlay.opacity,
    };
    subEvents.push(oaEvent);
    ops.push({ type: 'overlayAdd', overlayId: newOvId, overlayData: oaEvent });
  }

  return { subEvents, ops, newStrokeIds, newOverlayIds };
}