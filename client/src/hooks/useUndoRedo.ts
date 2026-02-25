/**
 * hooks/useUndoRedo.ts — Undo/Redo Shell フック (L3)
 *
 * React 状態として UndoEngineState を保持し、
 * core/undo-engine.ts の純粋関数を呼び出すグルーコード。
 *
 * Phase 3a で useYjsSync から分離。
 *
 * 責務:
 *   - undoStack / redoStack の React 状態管理
 *   - 遅延構築（非同期チャンク版）の制御
 *   - performUndo / performRedo → core の結果を appendEvents で反映
 *   - pushOp: 新操作をスタックに追加（useYjsSync から呼ばれる）
 */

import { useState, useCallback, useRef } from 'react';
import type {
  WbelxEvent,
  WbelxState,
  Operation,
} from '../types';
import {
  type UndoEngineState,
  type UndoContext,
  type ActiveState,
  createUndoEngineState,
  performUndo as corePerformUndo,
  performRedo as corePerformRedo,
  buildUndoEngineState,
  buildUndoEngineStateAsync,
} from '../core/undo-engine';
import {
  generateEraseId, generateRemoveId, generateTransformOpId,
  generateViewportOpId, generateStyleOpId, generateBgOpId,
  generateCsOpId, generateBatchId, getTimestamp,
} from '../utils/common';

// ========================================
// 定数
// ========================================

/**
 * イベント数がこの閾値以下なら同期版で即座に構築。
 * 超える場合は非同期チャンク版でバックグラウンド構築する。
 */
const LAZY_BUILD_THRESHOLD = 1000;

// ========================================
// 型定義
// ========================================

export interface UseUndoRedoOptions {
  /** セッション ID（Local Undo 用フィルタ） */
  sessionId: string;
  /** 現在の WbelxState（activeStrokeIds / activeOverlayIds のチェック用） */
  state: WbelxState;
  /** イベントを Yjs に追加するコールバック */
  appendEvents: (events: WbelxEvent[]) => void;
}

export interface UseUndoRedoReturn {
  /** Undo を実行 */
  performUndo: () => void;
  /** Redo を実行 */
  performRedo: () => void;
  /** Undo 可能か */
  canUndo: boolean;
  /** Redo 可能か */
  canRedo: boolean;
  /** Undo スタック構築済みか */
  undoStackReady: boolean;
  /**
   * 新しい Operation をスタックに追加する。
   * useYjsSync の各イベント追加メソッドから呼ばれる。
   * 呼び出し時に Redo スタックはクリアされる。
   */
  pushOp: (op: Operation) => void;
  /**
   * イベント列から Undo スタックを構築する。
   * 初期ロード時 / P2P 同期完了時に呼ばれる。
   */
  startUndoStackBuild: (events: WbelxEvent[]) => void;
}

// ========================================
// ブラウザ固有: yield 関数
// ========================================

/** Scheduling API (Prioritized Task Scheduling, Chrome 129+) */
interface SchedulerLike {
  yield?: () => Promise<void>;
}

/** メインスレッドに制御を返す yield 関数 */
function yieldToMain(): Promise<void> {
  const s = globalThis as typeof globalThis & { scheduler?: SchedulerLike };
  if (s.scheduler?.yield) {
    return s.scheduler.yield();
  }
  return new Promise(resolve => setTimeout(resolve, 0));
}

// ========================================
// ID 生成器オブジェクト（Core 層に注入）
// ========================================

const idGenerators = {
  generateEraseId,
  generateRemoveId,
  generateTransformOpId,
  generateViewportOpId,
  generateStyleOpId,
  generateBgOpId,
  generateCsOpId,
  generateBatchId,
};

// ========================================
// フック本体
// ========================================

export function useUndoRedo({
  sessionId,
  state,
  appendEvents,
}: UseUndoRedoOptions): UseUndoRedoReturn {
  // Undo エンジン状態
  const [engineState, setEngineState] = useState<UndoEngineState>(createUndoEngineState);
  const [undoStackReady, setUndoStackReady] = useState(false);

  // 非同期ビルドのキャンセル制御
  const abortRef = useRef<AbortController | null>(null);

  // ---- UndoStack 構築 ----
  const startUndoStackBuild = useCallback((evts: WbelxEvent[]) => {
    // 進行中の非同期ビルドをキャンセル
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }

    if (evts.length <= LAZY_BUILD_THRESHOLD) {
      // 同期版で即座に構築
      setEngineState(buildUndoEngineState(evts, sessionId));
      setUndoStackReady(true);
    } else {
      // 非同期チャンク版でバックグラウンド構築
      setUndoStackReady(false);
      const controller = new AbortController();
      abortRef.current = controller;

      buildUndoEngineStateAsync(
        evts,
        sessionId,
        yieldToMain,
        { isCancelled: () => controller.signal.aborted },
      ).then(newState => {
        if (!controller.signal.aborted) {
          setEngineState(newState);
          setUndoStackReady(true);
          abortRef.current = null;
        }
      });
    }
  }, [sessionId]);

  // ---- 新操作の登録 ----
  const pushOp = useCallback((op: Operation) => {
    // ユーザー操作が入った場合、進行中の非同期ビルドをキャンセルして即座に ready にする
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
      setUndoStackReady(true);
    }
    setEngineState(prev => ({
      ...prev,
      undoStack: [...prev.undoStack, op],
      redoStack: [],
    }));
  }, []);

  // ---- Undo ----
  const performUndo = useCallback(() => {
    const ctx: UndoContext = {
      timestamp: getTimestamp(),
      sessionId,
      idGenerators,
    };
    const activeState: ActiveState = {
      activeStrokeIds: state.activeStrokeIds,
      activeOverlayIds: state.activeOverlayIds,
    };
    const result = corePerformUndo(engineState, activeState, ctx);
    if (result) {
      setEngineState(result.newState);
      appendEvents(result.events);
    }
  }, [engineState, state, sessionId, appendEvents]);

  // ---- Redo ----
  const performRedo = useCallback(() => {
    const ctx: UndoContext = {
      timestamp: getTimestamp(),
      sessionId,
      idGenerators,
    };
    const result = corePerformRedo(engineState, ctx);
    if (result) {
      setEngineState(result.newState);
      appendEvents(result.events);
    }
  }, [engineState, sessionId, appendEvents]);

  // ---- 派生値 ----
  const canUndo = undoStackReady && engineState.undoStack.length > 0;
  const canRedo = undoStackReady && engineState.redoStack.length > 0;

  return {
    performUndo,
    performRedo,
    canUndo,
    canRedo,
    undoStackReady,
    pushOp,
    startUndoStackBuild,
  };
}
