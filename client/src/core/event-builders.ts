/**
 * core/event-builders.ts — イベント生成ファクトリ（Rust 移植対象）
 *
 * React 非依存。ブラウザ API 非依存。
 *
 * 移動元:
 *   - (旧) useYjs.ts: offsetSvgPathSimple, createUndoSubEvent, createRedoSubEvent
 *   - (旧) BoardEditor.tsx: 各種 OA/OR/OT/OV/OS イベント組み立て
 *
 * 参照仕様:
 *   impl-guide v4 §Undo/Redo「逆操作の導出規則」:
 *     数値デルタ → 符号反転, 色デルタ → 各チャネル符号反転, 列挙 → prev/next 交換
 */

/** Negate a number, normalizing -0 to 0 */
const neg = (x: number): number => -x || 0;

import type {
  SubEvent,
  SingleOperation,
  BatchEvent,
  BBox,
} from './types';

// ========================================
// SVG パスユーティリティ
// ========================================

/**
 * SVG パス文字列を dx, dy だけオフセットする。
 * Lasso 移動・複製で使用。
 */
export function offsetSvgPath(path: string, dx: number, dy: number): string {
  if (dx === 0 && dy === 0) return path;
  let idx = 0;
  return path.replace(/-?[\d.]+/g, (match) => {
    const val = parseFloat(match);
    const isX = idx % 2 === 0;
    idx++;
    return String(Math.round((val + (isX ? dx : dy)) * 100) / 100);
  });
}

/** BBox を dx, dy だけオフセットする */
export function offsetBbox(bbox: BBox, dx: number, dy: number): BBox {
  return [bbox[0] + dx, bbox[1] + dy, bbox[2] + dx, bbox[3] + dy];
}

// ========================================
// Undo 用逆操作サブイベント生成
// ========================================

/**
 * SingleOperation の逆操作サブイベントを生成（Undo 時）。
 *
 * impl-guide v4 §Undo/Redo「逆操作の導出規則」に準拠:
 *   数値デルタ → 符号反転
 *   色デルタ → 各チャネル符号反転
 *   列挙 → prev と next を交換
 *
 * @param op 元の操作
 * @param ts タイムスタンプ
 * @param sid セッション ID
 * @param generateEraseId E イベント ID 生成関数
 * @param generateRemoveId OR イベント ID 生成関数
 * @param generateTransformOpId OT イベント ID 生成関数
 * @param generateViewportOpId OV イベント ID 生成関数
 * @param generateStyleOpId OS イベント ID 生成関数
 * @param generateBgOpId BG イベント ID 生成関数
 * @param generateCsOpId CS イベント ID 生成関数
 */
export function createUndoSubEvent(
  op: SingleOperation,
  ts: string,
  sid: string,
  idGenerators: {
    generateEraseId: () => string;
    generateRemoveId: () => string;
    generateTransformOpId: () => string;
    generateViewportOpId: () => string;
    generateStyleOpId: () => string;
    generateBgOpId: () => string;
    generateCsOpId: () => string;
  },
): SubEvent {
  switch (op.type) {
    case 'draw':
      return { type: 'E', timestamp: ts, sessionId: sid, id: idGenerators.generateEraseId(), targetId: op.strokeId };
    case 'erase':
      return { ...op.targetStroke, timestamp: ts, sessionId: sid };
    case 'overlayAdd':
      return { type: 'OR', timestamp: ts, sessionId: sid, removeId: idGenerators.generateRemoveId(), targetOverlayId: op.overlayId };
    case 'overlayRemove':
      return { ...op.targetOverlay, timestamp: ts, sessionId: sid };
    case 'overlayTransform':
      return {
        type: 'OT', timestamp: ts, sessionId: sid, id: idGenerators.generateTransformOpId(), overlayId: op.overlayId,
        ...(op.dx !== 0 && { dx: neg(op.dx) }), ...(op.dy !== 0 && { dy: neg(op.dy) }),
        ...(op.dWidth !== 0 && { dWidth: neg(op.dWidth) }), ...(op.dHeight !== 0 && { dHeight: neg(op.dHeight) }),
        ...(op.dRotation !== 0 && { dRotation: neg(op.dRotation) }),
      };
    case 'overlayViewport':
      return {
        type: 'OV', timestamp: ts, sessionId: sid, id: idGenerators.generateViewportOpId(), overlayId: op.overlayId,
        ...(op.dViewport && {
          dViewport: {
            ...(op.dViewport.dx !== undefined && { dx: neg(op.dViewport.dx) }),
            ...(op.dViewport.dy !== undefined && { dy: neg(op.dViewport.dy) }),
            ...(op.dViewport.dWidth !== undefined && { dWidth: neg(op.dViewport.dWidth) }),
            ...(op.dViewport.dHeight !== undefined && { dHeight: neg(op.dViewport.dHeight) }),
          },
        }),
        ...(op.dPage !== undefined && { dPage: neg(op.dPage) }),
      };
    case 'overlayStyle':
      return {
        type: 'OS', timestamp: ts, sessionId: sid, id: idGenerators.generateStyleOpId(), overlayId: op.overlayId,
        ...(op.dzIndex !== undefined && { dzIndex: neg(op.dzIndex) }),
        ...(op.dOpacity !== undefined && { dOpacity: neg(op.dOpacity) }),
      };
    case 'background':
      return {
        type: 'BG', timestamp: ts, sessionId: sid, id: idGenerators.generateBgOpId(),
        ...(op.dColor && { dColor: { space: 'srgb' as const, dr: neg(op.dColor.dr), dg: neg(op.dColor.dg), db: neg(op.dColor.db) } }),
        ...(op.pattern && { pattern: { prev: op.pattern.next, next: op.pattern.prev } }),
        ...(op.dPatternSize !== undefined && { dPatternSize: neg(op.dPatternSize) }),
        ...(op.dPatternColor && { dPatternColor: { space: 'srgb' as const, dr: neg(op.dPatternColor.dr), dg: neg(op.dPatternColor.dg), db: neg(op.dPatternColor.db) } }),
      };
    case 'canvasSize':
      return {
        type: 'CS', timestamp: ts, sessionId: sid, id: idGenerators.generateCsOpId(),
        ...(op.dCanvasWidth !== undefined && { dCanvasWidth: neg(op.dCanvasWidth) }),
        ...(op.dCanvasHeight !== undefined && { dCanvasHeight: neg(op.dCanvasHeight) }),
      };
  }
}

// ========================================
// Redo 用再実行サブイベント生成
// ========================================

/**
 * SingleOperation の再実行サブイベントを生成（Redo 時）。
 *
 * @param op 元の操作
 * @param ts タイムスタンプ
 * @param sid セッション ID
 */
export function createRedoSubEvent(
  op: SingleOperation,
  ts: string,
  sid: string,
  idGenerators: {
    generateEraseId: () => string;
    generateRemoveId: () => string;
    generateTransformOpId: () => string;
    generateViewportOpId: () => string;
    generateStyleOpId: () => string;
    generateBgOpId: () => string;
    generateCsOpId: () => string;
  },
): SubEvent {
  switch (op.type) {
    case 'draw':
      return { ...op.strokeData, timestamp: ts, sessionId: sid };
    case 'erase':
      return { type: 'E', timestamp: ts, sessionId: sid, id: idGenerators.generateEraseId(), targetId: op.targetId };
    case 'overlayAdd':
      return { ...op.overlayData, timestamp: ts, sessionId: sid };
    case 'overlayRemove':
      return { type: 'OR', timestamp: ts, sessionId: sid, removeId: idGenerators.generateRemoveId(), targetOverlayId: op.targetOverlayId };
    case 'overlayTransform':
      return {
        type: 'OT', timestamp: ts, sessionId: sid, id: idGenerators.generateTransformOpId(), overlayId: op.overlayId,
        ...(op.dx !== 0 && { dx: op.dx }), ...(op.dy !== 0 && { dy: op.dy }),
        ...(op.dWidth !== 0 && { dWidth: op.dWidth }), ...(op.dHeight !== 0 && { dHeight: op.dHeight }),
        ...(op.dRotation !== 0 && { dRotation: op.dRotation }),
      };
    case 'overlayViewport':
      return {
        type: 'OV', timestamp: ts, sessionId: sid, id: idGenerators.generateViewportOpId(), overlayId: op.overlayId,
        ...(op.dViewport && { dViewport: op.dViewport }),
        ...(op.dPage !== undefined && { dPage: op.dPage }),
      };
    case 'overlayStyle':
      return {
        type: 'OS', timestamp: ts, sessionId: sid, id: idGenerators.generateStyleOpId(), overlayId: op.overlayId,
        ...(op.dzIndex !== undefined && { dzIndex: op.dzIndex }),
        ...(op.dOpacity !== undefined && { dOpacity: op.dOpacity }),
      };
    case 'background':
      return {
        type: 'BG', timestamp: ts, sessionId: sid, id: idGenerators.generateBgOpId(),
        ...(op.dColor && { dColor: op.dColor }),
        ...(op.pattern && { pattern: op.pattern }),
        ...(op.dPatternSize !== undefined && { dPatternSize: op.dPatternSize }),
        ...(op.dPatternColor && { dPatternColor: op.dPatternColor }),
      };
    case 'canvasSize':
      return {
        type: 'CS', timestamp: ts, sessionId: sid, id: idGenerators.generateCsOpId(),
        ...(op.dCanvasWidth !== undefined && { dCanvasWidth: op.dCanvasWidth }),
        ...(op.dCanvasHeight !== undefined && { dCanvasHeight: op.dCanvasHeight }),
      };
  }
}

// ========================================
// BATCH イベントファクトリ
// ========================================

/**
 * サブイベント列から BATCH イベントを構築する。
 * サブイベントが 1 件の場合は BATCH に包まず単体を返す。
 * 0 件の場合は null を返す。
 */
export function wrapAsBatchOrSingle(
  subEvents: SubEvent[],
  batchId: string,
  timestamp: string,
  sessionId: string,
): BatchEvent | SubEvent | null {
  if (subEvents.length === 0) return null;
  if (subEvents.length === 1) return subEvents[0];
  return {
    type: 'BATCH',
    id: batchId,
    timestamp,
    sessionId,
    events: subEvents,
  };
}