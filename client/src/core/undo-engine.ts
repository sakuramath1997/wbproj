/**
 * core/undo-engine.ts — Undo/Redo エンジン（Rust 移植対象）
 *
 * React 非依存。ブラウザ API 非依存。
 *
 * 移動元:
 *   - (旧) utils/undo-stack.ts: processSubEvent, buildUndoStack, buildUndoStackAsync
 *   - (旧) hooks/useYjs.ts: performUndo, performRedo ロジック
 *
 * 参照仕様:
 *   wbel-implementation-guide v4 §Undo/Redo:
 *     wbelx フォーマットは Undo/Redo 操作を定義しない — アプリケーション層の責務。
 *     wbelx v4 のデルタ記録方式により、逆操作はイベント自体から導出できる。
 *
 *   同「遅延構築の推奨」:
 *     大規模なボードでは描画状態の復元を先に完了し、
 *     Undo/Redo スタックの構築はバックグラウンドで遅延実行する。
 *
 * パターン: State + 操作関数（§4.2）
 *   TypeScript: interface State + function operate(state, args): NewState
 *   Rust 対応: struct State + impl State { fn operate(&mut self, args) }
 */

import type {
  WbelxEvent,
  SubEvent,
  DrawEvent,
  OverlayAddEvent,
  SingleOperation,
  BatchEvent,
  Operation,
} from './types';

import {
  createUndoSubEvent,
  createRedoSubEvent,
} from './event-builders';

// ========================================
// 型定義
// ========================================

/** Undo エンジンの状態オブジェクト */
export interface UndoEngineState {
  /** Undo スタック（末尾が最新） */
  readonly undoStack: ReadonlyArray<Operation>;
  /** Redo スタック（末尾が最新） */
  readonly redoStack: ReadonlyArray<Operation>;
  /**
   * 最後に構築済みのイベントインデックス。
   * インクリメンタル構築時にこの位置から続きを処理する。
   */
  readonly lastBuildIndex: number;
  /** 非同期構築が進行中かどうか */
  readonly isBuilding: boolean;
  /**
   * 内部トラッキング用データ。
   * 全セッションのストローク/オーバーレイデータを追跡する
   * （他セッションの OA を参照する OR の Undo に必要）。
   */
  readonly strokeData: ReadonlyMap<string, DrawEvent>;
  readonly overlayData: ReadonlyMap<string, OverlayAddEvent>;
}

/** ID 生成関数群。Core 層から外部に委譲する。 */
export interface IdGenerators {
  generateEraseId: () => string;
  generateRemoveId: () => string;
  generateTransformOpId: () => string;
  generateViewportOpId: () => string;
  generateStyleOpId: () => string;
  generateBgOpId: () => string;
  generateCsOpId: () => string;
  generateBatchId: () => string;
}

/** タイムスタンプ + セッション ID の供給 */
export interface UndoContext {
  timestamp: string;
  sessionId: string;
  idGenerators: IdGenerators;
}

/** Active state reference for skip checks */
export interface ActiveState {
  activeStrokeIds: ReadonlySet<string>;
  activeOverlayIds: ReadonlySet<string>;
}

/** performUndo / performRedo の戻り値 */
export interface UndoRedoResult {
  newState: UndoEngineState;
  /** Yjs に追加すべきイベント列 */
  events: WbelxEvent[];
}

// ========================================
// 初期状態
// ========================================

export function createUndoEngineState(): UndoEngineState {
  return {
    undoStack: [],
    redoStack: [],
    lastBuildIndex: 0,
    isBuilding: false,
    strokeData: new Map(),
    overlayData: new Map(),
  };
}

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
// スタック構築
// ========================================

/**
 * イベント列から UndoEngineState を構築する（同期版・フル構築）。
 * Local Undo: sessionId が一致するイベントのみをスタックに積む。
 * 全セッションの strokeData / overlayData は追跡する。
 */
export function buildUndoEngineState(
  events: ReadonlyArray<WbelxEvent>,
  sessionId: string,
): UndoEngineState {
  const strokeData = new Map<string, DrawEvent>();
  const overlayData = new Map<string, OverlayAddEvent>();
  const undoStack: Operation[] = [];

  for (const event of events) {
    processEvent(event, sessionId, undoStack, strokeData, overlayData);
  }

  return {
    undoStack,
    redoStack: [],
    lastBuildIndex: events.length,
    isBuilding: false,
    strokeData,
    overlayData,
  };
}

/**
 * イベント列からスタックを増分構築（差分のみ処理）。
 * state.lastBuildIndex から events の末尾まで処理する。
 */
export function buildUndoStackIncremental(
  state: UndoEngineState,
  events: ReadonlyArray<WbelxEvent>,
  sessionId: string,
): UndoEngineState {
  if (events.length <= state.lastBuildIndex) return state;

  // Mutable copies for incremental processing
  const strokeData = new Map(state.strokeData);
  const overlayData = new Map(state.overlayData);
  const undoStack = [...state.undoStack];

  for (let i = state.lastBuildIndex; i < events.length; i++) {
    processEvent(events[i], sessionId, undoStack, strokeData, overlayData);
  }

  return {
    ...state,
    undoStack,
    lastBuildIndex: events.length,
    strokeData,
    overlayData,
  };
}

/** 共通: 1 イベントを処理してスタック + データマップを更新 */
function processEvent(
  event: WbelxEvent,
  sessionId: string,
  stack: Operation[],
  strokeData: Map<string, DrawEvent>,
  overlayData: Map<string, OverlayAddEvent>,
): void {
  if (event.type === 'S') return;

  if (event.type === 'BATCH') {
    const ops: SingleOperation[] = [];
    for (const sub of (event as BatchEvent).events) {
      const op = processSubEvent(sub, strokeData, overlayData);
      if (op && event.sessionId === sessionId) ops.push(op);
    }
    if (ops.length > 0) {
      stack.push({ type: 'batch', batchId: (event as BatchEvent).id, operations: ops });
    }
  } else {
    const sub = event as SubEvent;
    const op = processSubEvent(sub, strokeData, overlayData);
    if (op && sub.sessionId === sessionId) {
      stack.push(op);
    }
  }
}

// ========================================
// Undo 実行
// ========================================

/**
 * Undo を実行する。
 *
 * undoStack の末尾から操作を取り出し、逆操作イベントを生成して返す。
 * 操作は redoStack に移動する。
 *
 * @returns 新しい状態 + Yjs に追加すべきイベント。Undo 不可能な場合は null。
 */
export function performUndo(
  state: UndoEngineState,
  activeState: ActiveState,
  ctx: UndoContext,
): UndoRedoResult | null {
  if (state.undoStack.length === 0) return null;

  const op = state.undoStack[state.undoStack.length - 1];
  const { timestamp: ts, sessionId: sid, idGenerators } = ctx;
  const resultEvents: WbelxEvent[] = [];

  if (op.type === 'batch') {
    // BATCH Undo: 逆順に反転した BATCH を発行
    const undoSubs = op.operations
      .slice()
      .reverse()
      .map(sub => createUndoSubEvent(sub, ts, sid, idGenerators));
    const batch: BatchEvent = {
      type: 'BATCH',
      id: idGenerators.generateBatchId(),
      timestamp: ts,
      sessionId: sid,
      events: undoSubs,
    };
    resultEvents.push(batch);
  } else {
    const singleOp = op as SingleOperation;
    // draw/overlayAdd の Undo は対象がアクティブであることを確認
    if (singleOp.type === 'draw' && !activeState.activeStrokeIds.has(singleOp.strokeId)) return null;
    if (singleOp.type === 'overlayAdd' && !activeState.activeOverlayIds.has(singleOp.overlayId)) return null;
    const undoEvent = createUndoSubEvent(singleOp, ts, sid, idGenerators);
    resultEvents.push(undoEvent as WbelxEvent);
  }

  return {
    newState: {
      ...state,
      undoStack: state.undoStack.slice(0, -1),
      redoStack: [...state.redoStack, op],
    },
    events: resultEvents,
  };
}

// ========================================
// Redo 実行
// ========================================

/**
 * Redo を実行する。
 *
 * redoStack の末尾から操作を取り出し、再実行イベントを生成して返す。
 * 操作は undoStack に戻る。
 *
 * @returns 新しい状態 + Yjs に追加すべきイベント。Redo 不可能な場合は null。
 */
export function performRedo(
  state: UndoEngineState,
  ctx: UndoContext,
): UndoRedoResult | null {
  if (state.redoStack.length === 0) return null;

  const op = state.redoStack[state.redoStack.length - 1];
  const { timestamp: ts, sessionId: sid, idGenerators } = ctx;
  const resultEvents: WbelxEvent[] = [];

  if (op.type === 'batch') {
    const redoSubs = op.operations.map(sub => createRedoSubEvent(sub, ts, sid, idGenerators));
    const batch: BatchEvent = {
      type: 'BATCH',
      id: idGenerators.generateBatchId(),
      timestamp: ts,
      sessionId: sid,
      events: redoSubs,
    };
    resultEvents.push(batch);
  } else {
    const redoEvent = createRedoSubEvent(op as SingleOperation, ts, sid, idGenerators);
    resultEvents.push(redoEvent as WbelxEvent);
  }

  return {
    newState: {
      ...state,
      redoStack: state.redoStack.slice(0, -1),
      undoStack: [...state.undoStack, op],
    },
    events: resultEvents,
  };
}

// ========================================
// Redo スタッククリア
// ========================================

/**
 * 新しい操作が追加されたとき Redo スタックをクリアする。
 * 標準的な Undo/Redo の挙動: 新操作により Redo 履歴は無効化される。
 */
export function clearRedoStack(state: UndoEngineState): UndoEngineState {
  if (state.redoStack.length === 0) return state;
  return { ...state, redoStack: [] };
}

// ========================================
// 非同期チャンク版構築
// ========================================

export interface BuildAsyncOptions {
  /** 1チャンクあたりの処理イベント数（デフォルト: 500） */
  chunkSize?: number;
  /** 進捗コールバック: (processedCount, totalCount) */
  onProgress?: (processed: number, total: number) => void;
  /** キャンセル判定関数。true を返すとキャンセル。 */
  isCancelled?: () => boolean;
}

/**
 * イベント列から UndoEngineState を構築する（非同期チャンク版）。
 *
 * chunkSize 件ごとに制御を返すためのコールバック（yieldFn）を呼び出す。
 * Shell 層で setTimeout / scheduler.yield() をバインドして使用する。
 *
 * Core 層はブラウザ API（setTimeout 等）に直接依存しないため、
 * yield の仕組みは外部から注入する。
 */
export async function buildUndoEngineStateAsync(
  events: ReadonlyArray<WbelxEvent>,
  sessionId: string,
  yieldFn: () => Promise<void>,
  options: BuildAsyncOptions = {},
): Promise<UndoEngineState> {
  const { chunkSize = 500, onProgress, isCancelled } = options;

  const strokeData = new Map<string, DrawEvent>();
  const overlayData = new Map<string, OverlayAddEvent>();
  const undoStack: Operation[] = [];
  const total = events.length;

  for (let i = 0; i < total; i++) {
    // チャンク境界で yield
    if (i > 0 && i % chunkSize === 0) {
      if (isCancelled?.()) {
        return {
          undoStack,
          redoStack: [],
          lastBuildIndex: i,
          isBuilding: false,
          strokeData,
          overlayData,
        };
      }
      onProgress?.(i, total);
      await yieldFn();
      if (isCancelled?.()) {
        return {
          undoStack,
          redoStack: [],
          lastBuildIndex: i,
          isBuilding: false,
          strokeData,
          overlayData,
        };
      }
    }

    processEvent(events[i], sessionId, undoStack, strokeData, overlayData);
  }

  onProgress?.(total, total);

  return {
    undoStack,
    redoStack: [],
    lastBuildIndex: total,
    isBuilding: false,
    strokeData,
    overlayData,
  };
}

// ========================================
// 後方互換: buildUndoStack 互換 API
// ========================================

/**
 * イベント列から Operation スタックを構築する（同期版）。
 * 旧 utils/undo-stack.ts の buildUndoStack と同一の出力を返す。
 */
export function buildUndoStack(
  events: ReadonlyArray<WbelxEvent>,
  sessionId: string,
): Operation[] {
  return buildUndoEngineState(events, sessionId).undoStack as Operation[];
}