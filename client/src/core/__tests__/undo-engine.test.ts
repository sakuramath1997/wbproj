import { describe, it, expect } from 'vitest';
import {
  createUndoEngineState,
  buildUndoEngineState,
  buildUndoStackIncremental,
  performUndo,
  performRedo,
  clearRedoStack,
  buildUndoStack,
} from '../undo-engine';
import type {
  WbelxEvent,
  DrawEvent,
  EraseEvent,
  OverlayAddEvent,
  OverlayTransformEvent,
  BackgroundEvent,
  SubEvent,
  BatchEvent,
} from '../types';
import type { UndoContext, ActiveState, IdGenerators } from '../undo-engine';

// ========================================
// テストヘルパー
// ========================================

const SESSION = 'sess_local';
const OTHER_SESSION = 'sess_remote';

const mockIdGenerators: IdGenerators = {
  generateEraseId: () => 'e:gen',
  generateRemoveId: () => 'rm:gen',
  generateTransformOpId: () => 'ot:gen',
  generateViewportOpId: () => 'ov:gen',
  generateStyleOpId: () => 'os:gen',
  generateBgOpId: () => 'bg:gen',
  generateCsOpId: () => 'cs:gen',
  generateBatchId: () => 'b:gen',
};

const makeCtx = (ts = '2026-01-01T00:00:01.000Z'): UndoContext => ({
  timestamp: ts,
  sessionId: SESSION,
  idGenerators: mockIdGenerators,
});

const allActive: ActiveState = {
  activeStrokeIds: new Set(['s:001', 's:002', 's:003', 's:004', 's:005']),
  activeOverlayIds: new Set(['o:001', 'o:002', 'o:003']),
};

function makeD(id: string, sessionId = SESSION): DrawEvent {
  return {
    type: 'D', timestamp: '2026-01-01T00:00:00.000Z', sessionId, id,
    color: '#000', width: 2, bbox: [0, 0, 10, 10], path: 'M 0 0 L 10 10',
  };
}

function makeE(id: string, targetId: string, sessionId = SESSION): EraseEvent {
  return { type: 'E', timestamp: '2026-01-01T00:00:00.000Z', sessionId, id, targetId };
}

function makeOA(overlayId: string, sessionId = SESSION): OverlayAddEvent {
  return {
    type: 'OA', timestamp: '2026-01-01T00:00:00.000Z', sessionId,
    overlayId, assetUuid: 'asset-001',
    x: 100, y: 200, width: 300, height: 200, rotation: 0,
    viewport: { x: 0, y: 0, width: 300, height: 200 },
    page: 1, zIndex: 1, opacity: 1.0,
  };
}

function makeOT(id: string, overlayId: string, dx: number, dy: number, sessionId = SESSION): OverlayTransformEvent {
  return { type: 'OT', timestamp: '2026-01-01T00:00:00.000Z', sessionId, id, overlayId, dx, dy };
}

function makeBG(id: string, sessionId = SESSION): BackgroundEvent {
  return {
    type: 'BG', timestamp: '2026-01-01T00:00:00.000Z', sessionId, id,
    dColor: { space: 'srgb', dr: -10, dg: -10, db: -10 },
    pattern: { prev: 'none', next: 'grid' },
  };
}

function makeBatch(id: string, subEvents: SubEvent[], sessionId = SESSION): BatchEvent {
  return { type: 'BATCH', id, timestamp: '2026-01-01T00:00:00.000Z', sessionId, events: subEvents };
}

// ========================================
// createUndoEngineState
// ========================================

describe('createUndoEngineState', () => {
  it('returns empty initial state', () => {
    const state = createUndoEngineState();
    expect(state.undoStack).toHaveLength(0);
    expect(state.redoStack).toHaveLength(0);
    expect(state.lastBuildIndex).toBe(0);
    expect(state.isBuilding).toBe(false);
  });
});

// ========================================
// buildUndoEngineState (sync full build)
// ========================================

describe('buildUndoEngineState', () => {
  it('returns empty state for empty events', () => {
    const state = buildUndoEngineState([], SESSION);
    expect(state.undoStack).toHaveLength(0);
    expect(state.lastBuildIndex).toBe(0);
  });

  it('builds stack for local session draw events', () => {
    const events: WbelxEvent[] = [makeD('s:001'), makeD('s:002')];
    const state = buildUndoEngineState(events, SESSION);
    expect(state.undoStack).toHaveLength(2);
    expect(state.lastBuildIndex).toBe(2);
  });

  it('filters out events from other sessions', () => {
    const events: WbelxEvent[] = [
      makeD('s:001', SESSION),
      makeD('s:002', OTHER_SESSION),
      makeD('s:003', SESSION),
    ];
    const state = buildUndoEngineState(events, SESSION);
    expect(state.undoStack).toHaveLength(2);
  });

  it('handles BATCH events', () => {
    const events: WbelxEvent[] = [
      makeD('s:001'),
      makeBatch('b:001', [makeE('e:001', 's:001')]),
    ];
    const state = buildUndoEngineState(events, SESSION);
    expect(state.undoStack).toHaveLength(2);
    expect(state.undoStack[1].type).toBe('batch');
  });

  it('tracks overlay data across sessions', () => {
    const events: WbelxEvent[] = [
      makeOA('o:001', OTHER_SESSION),
      { type: 'OR', timestamp: '', sessionId: SESSION, removeId: 'r:001', targetOverlayId: 'o:001' } as any,
    ];
    const state = buildUndoEngineState(events, SESSION);
    expect(state.undoStack).toHaveLength(1);
    expect(state.undoStack[0].type).toBe('overlayRemove');
  });

  it('skips S events', () => {
    const events: WbelxEvent[] = [
      makeD('s:001'),
      { type: 'S', timestamp: '', sessionId: '', snapshotHash: 'sha256:test' } as any,
      makeD('s:002'),
    ];
    const state = buildUndoEngineState(events, SESSION);
    expect(state.undoStack).toHaveLength(2);
  });
});

// ========================================
// buildUndoStackIncremental
// ========================================

describe('buildUndoStackIncremental', () => {
  it('processes only new events', () => {
    const events1: WbelxEvent[] = [makeD('s:001'), makeD('s:002')];
    const state1 = buildUndoEngineState(events1, SESSION);

    const events2 = [...events1, makeD('s:003')];
    const state2 = buildUndoStackIncremental(state1, events2, SESSION);

    expect(state2.undoStack).toHaveLength(3);
    expect(state2.lastBuildIndex).toBe(3);
  });

  it('returns same state if no new events', () => {
    const events: WbelxEvent[] = [makeD('s:001')];
    const state1 = buildUndoEngineState(events, SESSION);
    const state2 = buildUndoStackIncremental(state1, events, SESSION);
    expect(state2).toBe(state1);
  });

  it('preserves tracking data for cross-session references', () => {
    const events1: WbelxEvent[] = [makeOA('o:001', OTHER_SESSION)];
    const state1 = buildUndoEngineState(events1, SESSION);

    const events2: WbelxEvent[] = [
      ...events1,
      { type: 'OR', timestamp: '', sessionId: SESSION, removeId: 'r:001', targetOverlayId: 'o:001' } as any,
    ];
    const state2 = buildUndoStackIncremental(state1, events2, SESSION);
    expect(state2.undoStack).toHaveLength(1);
    expect(state2.undoStack[0].type).toBe('overlayRemove');
  });
});

// ========================================
// performUndo
// ========================================

describe('performUndo', () => {
  it('returns null for empty undoStack', () => {
    const state = createUndoEngineState();
    const result = performUndo(state, allActive, makeCtx());
    expect(result).toBeNull();
  });

  it('undoes a draw event by generating an erase', () => {
    const events: WbelxEvent[] = [makeD('s:001')];
    const state = buildUndoEngineState(events, SESSION);
    const result = performUndo(state, allActive, makeCtx())!;

    expect(result).not.toBeNull();
    expect(result.newState.undoStack).toHaveLength(0);
    expect(result.newState.redoStack).toHaveLength(1);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].type).toBe('E');
  });

  it('undoes a BATCH by generating a reversed BATCH', () => {
    const events: WbelxEvent[] = [
      makeD('s:001'),
      makeD('s:002'),
      makeBatch('b:001', [makeE('e:001', 's:001'), makeE('e:002', 's:002')]),
    ];
    const state = buildUndoEngineState(events, SESSION);
    const result = performUndo(state, allActive, makeCtx())!;

    expect(result.events).toHaveLength(1);
    expect(result.events[0].type).toBe('BATCH');
    const batch = result.events[0] as BatchEvent;
    // Reversed: first re-draw s:002, then s:001
    expect(batch.events).toHaveLength(2);
    expect(batch.events[0].type).toBe('D');
    expect(batch.events[1].type).toBe('D');
  });

  it('skips undo of draw if stroke is not active', () => {
    const events: WbelxEvent[] = [makeD('s:999')]; // not in allActive
    const state = buildUndoEngineState(events, SESSION);
    const result = performUndo(state, allActive, makeCtx());
    expect(result).toBeNull();
  });

  it('undoes overlayTransform by negating deltas', () => {
    const events: WbelxEvent[] = [
      makeOA('o:001'),
      makeOT('ot:001', 'o:001', 50, 30),
    ];
    const state = buildUndoEngineState(events, SESSION);
    const result = performUndo(state, allActive, makeCtx())!;

    expect(result.events[0].type).toBe('OT');
    const ot = result.events[0] as any;
    expect(ot.dx).toBe(-50);
    expect(ot.dy).toBe(-30);
  });

  it('undoes background event by negating color delta and swapping enum', () => {
    const events: WbelxEvent[] = [makeBG('bg:001')];
    const state = buildUndoEngineState(events, SESSION);
    const result = performUndo(state, allActive, makeCtx())!;

    const bg = result.events[0] as any;
    expect(bg.type).toBe('BG');
    expect(bg.dColor.dr).toBe(10);
    expect(bg.dColor.dg).toBe(10);
    expect(bg.dColor.db).toBe(10);
    expect(bg.pattern.prev).toBe('grid');
    expect(bg.pattern.next).toBe('none');
  });
});

// ========================================
// performRedo
// ========================================

describe('performRedo', () => {
  it('returns null for empty redoStack', () => {
    const state = createUndoEngineState();
    const result = performRedo(state, makeCtx());
    expect(result).toBeNull();
  });

  it('redo after undo restores original operation', () => {
    const events: WbelxEvent[] = [makeD('s:001')];
    const state = buildUndoEngineState(events, SESSION);

    // Undo
    const undoResult = performUndo(state, allActive, makeCtx())!;
    expect(undoResult.newState.redoStack).toHaveLength(1);

    // Redo
    const redoResult = performRedo(undoResult.newState, makeCtx())!;
    expect(redoResult.newState.undoStack).toHaveLength(1);
    expect(redoResult.newState.redoStack).toHaveLength(0);
    expect(redoResult.events).toHaveLength(1);
    expect(redoResult.events[0].type).toBe('D'); // re-draw
  });

  it('redo a BATCH operation', () => {
    const events: WbelxEvent[] = [
      makeD('s:001'),
      makeBatch('b:001', [makeE('e:001', 's:001')]),
    ];
    const state = buildUndoEngineState(events, SESSION);
    const undoResult = performUndo(state, allActive, makeCtx())!;
    const redoResult = performRedo(undoResult.newState, makeCtx())!;

    expect(redoResult.events[0].type).toBe('BATCH');
    const batch = redoResult.events[0] as BatchEvent;
    expect(batch.events[0].type).toBe('E');
  });
});

// ========================================
// clearRedoStack
// ========================================

describe('clearRedoStack', () => {
  it('clears redo stack', () => {
    const events: WbelxEvent[] = [makeD('s:001')];
    const state = buildUndoEngineState(events, SESSION);
    const undoResult = performUndo(state, allActive, makeCtx())!;
    expect(undoResult.newState.redoStack).toHaveLength(1);

    const cleared = clearRedoStack(undoResult.newState);
    expect(cleared.redoStack).toHaveLength(0);
  });

  it('returns same state if redo stack already empty', () => {
    const state = createUndoEngineState();
    const result = clearRedoStack(state);
    expect(result).toBe(state);
  });
});

// ========================================
// buildUndoStack (backward compat)
// ========================================

describe('buildUndoStack (backward compat)', () => {
  it('returns same results as original utils/undo-stack', () => {
    const events: WbelxEvent[] = [
      makeD('s:001'),
      makeD('s:002', OTHER_SESSION),
      makeOA('o:001'),
      makeOT('ot:001', 'o:001', 50, 30),
      makeBatch('b:001', [makeE('e:001', 's:001')]),
      makeBG('bg:001'),
    ];
    const stack = buildUndoStack(events, SESSION);
    expect(stack).toHaveLength(5); // D + OA + OT + BATCH + BG (not D from OTHER)
    expect(stack[0].type).toBe('draw');
    expect(stack[1].type).toBe('overlayAdd');
    expect(stack[2].type).toBe('overlayTransform');
    expect(stack[3].type).toBe('batch');
    expect(stack[4].type).toBe('background');
  });
});