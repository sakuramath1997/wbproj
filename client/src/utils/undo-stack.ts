/**
 * Undo スタック構築ユーティリティ
 *
 * useYjs から抽出。同期版と非同期チャンク版を提供する。
 *
 * - buildUndoStack(): 同期版（テスト・小規模データ用）
 * - buildUndoStackAsync(): 非同期チャンク版（大規模データ用）
 *   chunkSize 件ごとにメインスレッドに制御を返す。
 *   AbortSignal によるキャンセル対応。
 *
 * 実装ガイド v4 §Undo/Redo「遅延構築の推奨」に準拠:
 *   大規模なボードでは描画状態の復元を先に完了し、
 *   Undo/Redo スタックの構築はバックグラウンドで遅延実行する。
 */

import type {
  WbelxEvent,
  SubEvent,
  DrawEvent,
  OverlayAddEvent,
  Operation,
  SingleOperation,
} from '../types';

// ========================================
// サブイベント → Operation 変換
// ========================================

/**
 * サブイベントを処理し、strokeData / overlayData マップを更新しつつ、
 * 対応する SingleOperation を返す。
 *
 * データマップの更新は副作用として常に行われる（全セッションのデータ追跡）。
 * Operation を生成できない場合（ターゲットが見つからない等）は null を返す。
 */
export function processSubEvent(
  event: SubEvent,
  strokeData: Map<string, DrawEvent>,
  overlayData: Map<string, OverlayAddEvent>,
): SingleOperation | null {
  switch (event.type) {
    case 'D':
      strokeData.set(event.id, event);
      return { type: 'draw', strokeId: event.id, strokeData: event };
    case 'E': {
      const target = strokeData.get(event.targetId);
      if (!target) return null;
      return { type: 'erase', eraseId: event.id, targetId: event.targetId, targetStroke: target };
    }
    case 'OA':
      overlayData.set(event.overlayId, event);
      return { type: 'overlayAdd', overlayId: event.overlayId, overlayData: event };
    case 'OR': {
      const target = overlayData.get(event.targetOverlayId);
      if (!target) return null;
      return { type: 'overlayRemove', removeId: event.removeId, targetOverlayId: event.targetOverlayId, targetOverlay: target };
    }
    case 'OT':
      return {
        type: 'overlayTransform', id: event.id, overlayId: event.overlayId,
        dx: event.dx ?? 0, dy: event.dy ?? 0, dWidth: event.dWidth ?? 0,
        dHeight: event.dHeight ?? 0, dRotation: event.dRotation ?? 0,
      };
    case 'OV':
      return {
        type: 'overlayViewport', id: event.id, overlayId: event.overlayId,
        ...(event.dViewport && { dViewport: event.dViewport }),
        ...(event.dPage !== undefined && { dPage: event.dPage }),
      };
    case 'OS':
      return {
        type: 'overlayStyle', id: event.id, overlayId: event.overlayId,
        ...(event.dzIndex !== undefined && { dzIndex: event.dzIndex }),
        ...(event.dOpacity !== undefined && { dOpacity: event.dOpacity }),
      };
    case 'BG':
      return {
        type: 'background', id: event.id,
        ...(event.dColor && { dColor: event.dColor }),
        ...(event.pattern && { pattern: event.pattern }),
        ...(event.dPatternSize !== undefined && { dPatternSize: event.dPatternSize }),
        ...(event.dPatternColor && { dPatternColor: event.dPatternColor }),
      };
    case 'CS':
      return {
        type: 'canvasSize', id: event.id,
        ...(event.dCanvasWidth !== undefined && { dCanvasWidth: event.dCanvasWidth }),
        ...(event.dCanvasHeight !== undefined && { dCanvasHeight: event.dCanvasHeight }),
      };
    default:
      return null;
  }
}

// ========================================
// 同期版: buildUndoStack
// ========================================

/**
 * イベント列から Undo スタックを構築する（同期版）。
 * Local Undo: sessionId が一致するイベントのみをスタックに積む。
 *
 * 全セッションの strokeData / overlayData は追跡する
 * （他セッションの OA を参照する OR の Undo に必要）。
 */
export function buildUndoStack(events: WbelxEvent[], sessionId: string): Operation[] {
  const stack: Operation[] = [];
  const strokeData = new Map<string, DrawEvent>();
  const overlayData = new Map<string, OverlayAddEvent>();

  for (const event of events) {
    if (event.type === 'S') continue;

    if (event.type === 'BATCH') {
      const ops: SingleOperation[] = [];
      for (const sub of event.events) {
        const op = processSubEvent(sub, strokeData, overlayData);
        if (op && event.sessionId === sessionId) ops.push(op);
      }
      if (ops.length > 0) {
        stack.push({ type: 'batch', batchId: event.id, operations: ops });
      }
    } else {
      const sub = event as SubEvent;
      const op = processSubEvent(sub, strokeData, overlayData);
      if (op && sub.sessionId === sessionId) {
        stack.push(op);
      }
    }
  }

  return stack;
}

// ========================================
// 非同期チャンク版: buildUndoStackAsync
// ========================================

export interface BuildUndoStackAsyncOptions {
  /** 1チャンクあたりの処理イベント数（デフォルト: 500） */
  chunkSize?: number;
  /** 進捗コールバック: (processedCount, totalCount) */
  onProgress?: (processed: number, total: number) => void;
  /** キャンセルシグナル */
  signal?: AbortSignal;
}

/** メインスレッドに制御を返す yield 関数 */
function yieldToMain(): Promise<void> {
  // scheduler.yield() は Scheduling API (Chrome 115+)
  const s = globalThis as any;
  if (s.scheduler?.yield) {
    return s.scheduler.yield();
  }
  return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * イベント列から Undo スタックを構築する（非同期チャンク版）。
 *
 * chunkSize 件ごとにメインスレッドに制御を返し、UI のブロッキングを回避する。
 * AbortSignal でキャンセル可能。キャンセル時はその時点までの部分結果を返す。
 */
export async function buildUndoStackAsync(
  events: WbelxEvent[],
  sessionId: string,
  options: BuildUndoStackAsyncOptions = {},
): Promise<Operation[]> {
  const {
    chunkSize = 500,
    onProgress,
    signal,
  } = options;

  const stack: Operation[] = [];
  const strokeData = new Map<string, DrawEvent>();
  const overlayData = new Map<string, OverlayAddEvent>();
  const total = events.length;

  for (let i = 0; i < total; i++) {
    // チャンク境界で yield
    if (i > 0 && i % chunkSize === 0) {
      if (signal?.aborted) return stack;
      onProgress?.(i, total);
      await yieldToMain();
      if (signal?.aborted) return stack;
    }

    const event = events[i];
    if (event.type === 'S') continue;

    if (event.type === 'BATCH') {
      const ops: SingleOperation[] = [];
      for (const sub of event.events) {
        const op = processSubEvent(sub, strokeData, overlayData);
        if (op && event.sessionId === sessionId) ops.push(op);
      }
      if (ops.length > 0) {
        stack.push({ type: 'batch', batchId: event.id, operations: ops });
      }
    } else {
      const sub = event as SubEvent;
      const op = processSubEvent(sub, strokeData, overlayData);
      if (op && sub.sessionId === sessionId) {
        stack.push(op);
      }
    }
  }

  onProgress?.(total, total);
  return stack;
}
