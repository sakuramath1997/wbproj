/**
 * core/__tests__/integration.test.ts
 *
 * 統合テスト: state-machine + undo-engine + event-builders + serializer を
 * 組み合わせた実際のユーザワークフローを検証する。
 *
 * テスト対象の保証:
 *   1. Draw → Erase → Undo → Redo の完全サイクル
 *   2. Overlay 操作 (Add → Transform → Undo → Redo)
 *   3. BATCH 操作の Undo/Redo
 *   4. BG / CS のデルタ Undo/Redo
 *   5. Minimize → 再リプレイの等価性
 *   6. ローカル Undo（他セッションのイベントはスキップ）
 *   7. 非同期 Undo スタック構築
 */

import { describe, it, expect } from 'vitest';
import {
  applyEvent,
  computeState,
  getActiveStrokes,
  getActiveOverlays,
} from '../state-machine';
import {
  buildUndoEngineState,
  buildUndoEngineStateAsync,
  performUndo,
  performRedo,
} from '../undo-engine';
import type {
  WbelxEvent,
  DrawEvent,
  EraseEvent,
  BatchEvent,
  OverlayAddEvent,
  OverlayTransformEvent,
  BackgroundEvent,
  CanvasSizeEvent,
  WbelxState,
} from '../types';
import type { UndoContext, ActiveState, UndoEngineState } from '../undo-engine';
import { minimizeWbelx } from '../minimize';
import { eventToJsonl } from '../serializer';

// ========================================
// ヘルパー
// ========================================

const ts = '2026-01-01T00:00:00.000Z';
const sid = 'user1';
const sid2 = 'user2';

function makeD(id: string, session = sid): DrawEvent {
  return {
    type: 'D', timestamp: ts, sessionId: session,
    id, color: '#000', width: 2,
    bbox: [0, 0, 100, 100], path: 'M 0 0 L 100 100',
  };
}

function makeE(id: string, targetId: string, session = sid): EraseEvent {
  return { type: 'E', timestamp: ts, sessionId: session, id, targetId };
}

function makeOA(overlayId: string, session = sid): OverlayAddEvent {
  return {
    type: 'OA', timestamp: ts, sessionId: session,
    overlayId, assetUuid: 'asset-001',
    x: 10, y: 20, width: 200, height: 150, rotation: 0,
    viewport: { x: 0, y: 0, width: 200, height: 150 },
    page: 1, zIndex: 1, opacity: 1.0,
  };
}

function makeOT(id: string, overlayId: string, dx: number, dy: number, session = sid): OverlayTransformEvent {
  return {
    type: 'OT', timestamp: ts, sessionId: session,
    id, overlayId, dx, dy,
  };
}

function makeBG(id: string, session = sid): BackgroundEvent {
  return {
    type: 'BG', timestamp: ts, sessionId: session, id,
    dColor: { space: 'srgb', dr: 50, dg: 0, db: 0 },
    pattern: { prev: 'none', next: 'grid' },
    dPatternSize: 10,
  };
}

function makeCS(id: string, dw: number, dh: number, session = sid): CanvasSizeEvent {
  return {
    type: 'CS', timestamp: ts, sessionId: session, id,
    dCanvasWidth: dw, dCanvasHeight: dh,
  };
}

/** 全イベントを順に適用して最終状態を返す */
function replay(events: WbelxEvent[]): WbelxState {
  return computeState(events);
}

/** UndoContext を作成 */
function makeCtx(session = sid): UndoContext {
  let idCounter = 1000;
  const gen = (prefix: string) => () => `${prefix}:undo_${idCounter++}`;
  return {
    timestamp: ts,
    sessionId: session,
    idGenerators: {
      generateEraseId: gen('e'),
      generateRemoveId: gen('r'),
      generateTransformOpId: gen('ot'),
      generateViewportOpId: gen('ov'),
      generateStyleOpId: gen('os'),
      generateBgOpId: gen('bg'),
      generateCsOpId: gen('cs'),
      generateBatchId: gen('b'),
    },
  };
}

/** Undo を実行し、結果イベントを events に追加、状態を更新して返す */
function doUndo(
  engineState: UndoEngineState,
  wbelxState: WbelxState,
  events: WbelxEvent[],
  session = sid,
): { engineState: UndoEngineState; wbelxState: WbelxState } | null {
  const active: ActiveState = {
    activeStrokeIds: wbelxState.activeStrokeIds,
    activeOverlayIds: wbelxState.activeOverlayIds,
  };
  const result = performUndo(engineState, active, makeCtx(session));
  if (!result) return null;

  for (const evt of result.events) {
    events.push(evt);
  }
  let newWbelxState = wbelxState;
  for (const evt of result.events) {
    newWbelxState = applyEvent(newWbelxState, evt);
  }
  return { engineState: result.newState, wbelxState: newWbelxState };
}

function doRedo(
  engineState: UndoEngineState,
  wbelxState: WbelxState,
  events: WbelxEvent[],
  session = sid,
): { engineState: UndoEngineState; wbelxState: WbelxState } | null {
  const result = performRedo(engineState, makeCtx(session));
  if (!result) return null;

  for (const evt of result.events) {
    events.push(evt);
  }
  let newWbelxState = wbelxState;
  for (const evt of result.events) {
    newWbelxState = applyEvent(newWbelxState, evt);
  }
  return { engineState: result.newState, wbelxState: newWbelxState };
}

// ========================================
// テスト
// ========================================

describe('Integration: Draw → Erase → Undo → Redo', () => {


  it('full cycle: draw 2 strokes, erase 1, undo erase, redo erase', () => {
    const events: WbelxEvent[] = [
      makeD('s:001'),
      makeD('s:002'),
      makeE('e:001', 's:001'),
    ];

    // 初期状態: s:002 のみアクティブ
    let state = replay(events);
    expect(getActiveStrokes(state)).toHaveLength(1);
    expect(state.activeStrokeIds.has('s:002')).toBe(true);
    expect(state.activeStrokeIds.has('s:001')).toBe(false);

    // Undo スタック構築
    let engine = buildUndoEngineState(events, sid);
    expect(engine.undoStack).toHaveLength(3);

    // Undo (erase の取り消し → s:001 復活)
    const undoResult = doUndo(engine, state, events);
    expect(undoResult).not.toBeNull();
    engine = undoResult!.engineState;
    state = undoResult!.wbelxState;
    expect(getActiveStrokes(state)).toHaveLength(2);
    expect(state.activeStrokeIds.has('s:001')).toBe(true);

    // Redo (再消去 → s:001 消去)
    const redoResult = doRedo(engine, state, events);
    expect(redoResult).not.toBeNull();
    engine = redoResult!.engineState;
    state = redoResult!.wbelxState;
    expect(getActiveStrokes(state)).toHaveLength(1);
    expect(state.activeStrokeIds.has('s:001')).toBe(false);
  });
});

describe('Integration: Overlay Add → Transform → Undo → Redo', () => {


  it('overlay transform is correctly undone and redone', () => {
    const events: WbelxEvent[] = [
      makeOA('o:001'),
      makeOT('ot:001', 'o:001', 50, 30),
    ];

    let state = replay(events);
    const overlays = getActiveOverlays(state);
    expect(overlays).toHaveLength(1);
    expect(overlays[0].x).toBe(60);  // 10 + 50
    expect(overlays[0].y).toBe(50);  // 20 + 30

    let engine = buildUndoEngineState(events, sid);

    // Undo (transform 取り消し → 元の位置に戻る)
    const undoResult = doUndo(engine, state, events);
    expect(undoResult).not.toBeNull();
    engine = undoResult!.engineState;
    state = undoResult!.wbelxState;

    const after = getActiveOverlays(state);
    expect(after[0].x).toBe(10);
    expect(after[0].y).toBe(20);

    // Redo (再移動)
    const redoResult = doRedo(engine, state, events);
    expect(redoResult).not.toBeNull();
    state = redoResult!.wbelxState;

    const final = getActiveOverlays(state);
    expect(final[0].x).toBe(60);
    expect(final[0].y).toBe(50);
  });

  it('undo overlay add removes it, redo restores it', () => {
    const events: WbelxEvent[] = [makeOA('o:001')];
    let state = replay(events);
    expect(getActiveOverlays(state)).toHaveLength(1);

    let engine = buildUndoEngineState(events, sid);

    // Undo OA → overlay が消える
    const undoResult = doUndo(engine, state, events);
    expect(undoResult).not.toBeNull();
    engine = undoResult!.engineState;
    state = undoResult!.wbelxState;
    expect(getActiveOverlays(state)).toHaveLength(0);

    // Redo → overlay が復活
    const redoResult = doRedo(engine, state, events);
    expect(redoResult).not.toBeNull();
    state = redoResult!.wbelxState;
    expect(getActiveOverlays(state)).toHaveLength(1);
    expect(getActiveOverlays(state)[0].overlayId).toBe('o:001');
  });
});

describe('Integration: BATCH Undo/Redo', () => {


  it('BATCH of 2 erases: undo restores both strokes', () => {
    const events: WbelxEvent[] = [
      makeD('s:001'),
      makeD('s:002'),
      {
        type: 'BATCH', id: 'b:001', timestamp: ts, sessionId: sid,
        events: [
          makeE('e:001', 's:001'),
          makeE('e:002', 's:002'),
        ],
      } as BatchEvent,
    ];

    let state = replay(events);
    expect(getActiveStrokes(state)).toHaveLength(0);

    let engine = buildUndoEngineState(events, sid);

    // Undo BATCH → 両方のストロークが復活
    const undoResult = doUndo(engine, state, events);
    expect(undoResult).not.toBeNull();
    engine = undoResult!.engineState;
    state = undoResult!.wbelxState;
    expect(getActiveStrokes(state)).toHaveLength(2);

    // Redo BATCH → 再消去
    const redoResult = doRedo(engine, state, events);
    expect(redoResult).not.toBeNull();
    state = redoResult!.wbelxState;
    expect(getActiveStrokes(state)).toHaveLength(0);
  });

  it('BATCH with mixed OT events: undo reverses all transforms', () => {
    const events: WbelxEvent[] = [
      makeOA('o:001'),
      makeOA('o:002'),
      {
        type: 'BATCH', id: 'b:001', timestamp: ts, sessionId: sid,
        events: [
          makeOT('ot:001', 'o:001', 100, 0),
          makeOT('ot:002', 'o:002', 0, 100),
        ],
      } as BatchEvent,
    ];

    let state = replay(events);
    let overlays = getActiveOverlays(state);
    expect(overlays.find(o => o.overlayId === 'o:001')!.x).toBe(110);
    expect(overlays.find(o => o.overlayId === 'o:002')!.y).toBe(120);

    const engine = buildUndoEngineState(events, sid);
    const undoResult = doUndo(engine, state, events);
    expect(undoResult).not.toBeNull();
    state = undoResult!.wbelxState;

    overlays = getActiveOverlays(state);
    expect(overlays.find(o => o.overlayId === 'o:001')!.x).toBe(10);
    expect(overlays.find(o => o.overlayId === 'o:002')!.y).toBe(20);
  });
});

describe('Integration: BG / CS delta Undo/Redo', () => {


  it('BG: undo reverts background change', () => {
    const events: WbelxEvent[] = [makeBG('bg:001')];

    let state = replay(events);
    expect(state.background).not.toBeNull();
    expect(state.background!.pattern).toBe('grid');

    const engine = buildUndoEngineState(events, sid);
    const undoResult = doUndo(engine, state, events);
    expect(undoResult).not.toBeNull();
    state = undoResult!.wbelxState;

    // BG のデルタが逆転: pattern が grid → none に戻る
    expect(state.background!.pattern).toBe('none');
  });

  it('CS: undo reverts canvas size change', () => {
    const events: WbelxEvent[] = [makeCS('cs:001', 1920, 1080)];

    let state = replay(events);
    expect(state.canvasWidth).toBe(1920);
    expect(state.canvasHeight).toBe(1080);

    const engine = buildUndoEngineState(events, sid);
    const undoResult = doUndo(engine, state, events);
    expect(undoResult).not.toBeNull();
    state = undoResult!.wbelxState;

    expect(state.canvasWidth).toBe(0);
    expect(state.canvasHeight).toBe(0);
  });
});

describe('Integration: Minimize → re-replay equivalence', () => {


  it('minimized events produce same state as original', () => {
    const events: WbelxEvent[] = [
      makeD('s:001'),
      makeD('s:002'),
      makeE('e:001', 's:001'),
      makeOA('o:001'),
      makeOT('ot:001', 'o:001', 50, 30),
      makeBG('bg:001'),
      makeCS('cs:001', 1920, 1080),
    ];

    const originalState = replay(events);
    const deps = {
      getTimestamp: () => ts,
      generateBgOpId: () => 'bg:min_001',
    };

    const result = minimizeWbelx(events, deps, 0, 0);

    // Minimize 後のイベントをリプレイ
    const minimizedState = replay(result.events);

    // ストローク
    const origStrokes = getActiveStrokes(originalState);
    const minStrokes = getActiveStrokes(minimizedState);
    expect(minStrokes).toHaveLength(origStrokes.length);
    for (const s of origStrokes) {
      expect(minStrokes.find(ms => ms.id === s.id)).toBeTruthy();
    }

    // オーバーレイ
    const origOverlays = getActiveOverlays(originalState);
    const minOverlays = getActiveOverlays(minimizedState);
    expect(minOverlays).toHaveLength(origOverlays.length);
    expect(minOverlays[0].x).toBe(origOverlays[0].x);
    expect(minOverlays[0].y).toBe(origOverlays[0].y);

    // 背景
    expect(minimizedState.background?.pattern).toBe(originalState.background?.pattern);

    // キャンバスサイズは H ヘッダーに格納される（イベントには含まれない）
    // minimize 結果の content から H ヘッダーを確認
    const headerLine = result.content.split('\n')[0];
    const header = JSON.parse(headerLine);
    expect(header.canvasWidth).toBe(originalState.canvasWidth);
    expect(header.canvasHeight).toBe(originalState.canvasHeight);
  });

  it('minimize output is valid JSONL round-trip via serializer', () => {
    const events: WbelxEvent[] = [makeD('s:001'), makeD('s:002')];
    const deps = {
      getTimestamp: () => ts,
      generateBgOpId: () => 'bg:min_001',
    };

    const result = minimizeWbelx(events, deps);

    // content の各行がパース可能
    const lines = result.content.split('\n');
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }

    // 各イベントの個別シリアライズが等価
    for (const evt of result.events) {
      const jsonl = eventToJsonl(evt);
      expect(() => JSON.parse(jsonl)).not.toThrow();
    }
  });
});

describe('Integration: Local Undo (multi-session)', () => {


  it('user1 cannot undo user2 operations', () => {
    const events: WbelxEvent[] = [
      makeD('s:001', sid),     // user1 の描画
      makeD('s:002', sid2),    // user2 の描画
      makeD('s:003', sid),     // user1 の描画
    ];

    const state = replay(events);
    expect(getActiveStrokes(state)).toHaveLength(3);

    // user1 の Undo スタック
    const engine = buildUndoEngineState(events, sid);
    // user1 のイベントのみがスタックに入る
    expect(engine.undoStack).toHaveLength(2);

    // user2 の Undo スタック
    const engine2 = buildUndoEngineState(events, sid2);
    expect(engine2.undoStack).toHaveLength(1);
  });

  it('local undo only affects own strokes', () => {
    const events: WbelxEvent[] = [
      makeD('s:001', sid),
      makeD('s:002', sid2),
      makeD('s:003', sid),
    ];

    let state = replay(events);
    const engine = buildUndoEngineState(events, sid);

    // user1 が Undo → s:003 が消える（s:002 はそのまま）
    const result = doUndo(engine, state, events, sid);
    expect(result).not.toBeNull();
    state = result!.wbelxState;

    expect(state.activeStrokeIds.has('s:001')).toBe(true);
    expect(state.activeStrokeIds.has('s:002')).toBe(true);  // user2
    expect(state.activeStrokeIds.has('s:003')).toBe(false);
  });
});

describe('Integration: Async undo stack build', () => {
  it('async build produces same result as sync build', async () => {
    const events: WbelxEvent[] = [];
    for (let i = 0; i < 100; i++) {
      events.push(makeD(`s:${String(i).padStart(4, '0')}`));
    }
    events.push(makeE('e:001', 's:0050'));

    const syncEngine = buildUndoEngineState(events, sid);

    const asyncEngine = await buildUndoEngineStateAsync(
      events,
      sid,
      () => Promise.resolve(),
      { chunkSize: 20 },
    );

    expect(asyncEngine.undoStack).toHaveLength(syncEngine.undoStack.length);
    expect(asyncEngine.lastBuildIndex).toBe(syncEngine.lastBuildIndex);
  });

  it('cancellation stops async build', async () => {
    const events: WbelxEvent[] = [];
    for (let i = 0; i < 100; i++) {
      events.push(makeD(`s:${String(i).padStart(4, '0')}`));
    }

    let cancelled = false;
    const engine = await buildUndoEngineStateAsync(
      events,
      sid,
      () => {
        // 最初の yield でキャンセル
        cancelled = true;
        return Promise.resolve();
      },
      { chunkSize: 10, isCancelled: () => cancelled },
    );

    // キャンセルされたので全件処理されていない
    expect(engine.lastBuildIndex).toBeLessThan(events.length);
  });
});

describe('Integration: Multiple undo/redo cycles preserve consistency', () => {


  it('3 draws, undo all 3, redo all 3', () => {
    const events: WbelxEvent[] = [
      makeD('s:001'),
      makeD('s:002'),
      makeD('s:003'),
    ];

    let state = replay(events);
    let engine = buildUndoEngineState(events, sid);

    // Undo 3 回
    for (let i = 0; i < 3; i++) {
      const result = doUndo(engine, state, events);
      expect(result).not.toBeNull();
      engine = result!.engineState;
      state = result!.wbelxState;
    }
    expect(getActiveStrokes(state)).toHaveLength(0);

    // 4 回目の Undo は null
    const active: ActiveState = {
      activeStrokeIds: state.activeStrokeIds,
      activeOverlayIds: state.activeOverlayIds,
    };
    expect(performUndo(engine, active, makeCtx())).toBeNull();

    // Redo 3 回
    for (let i = 0; i < 3; i++) {
      const result = doRedo(engine, state, events);
      expect(result).not.toBeNull();
      engine = result!.engineState;
      state = result!.wbelxState;
    }
    expect(getActiveStrokes(state)).toHaveLength(3);

    // 4 回目の Redo は null
    expect(performRedo(engine, makeCtx())).toBeNull();
  });
});
