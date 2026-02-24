import { describe, it, expect } from 'vitest';
import { buildUndoStack, buildUndoStackAsync, processSubEvent } from '../undo-stack';
import type {
  WbelxEvent,
  DrawEvent,
  EraseEvent,
  OverlayAddEvent,
  OverlayRemoveEvent,
  OverlayTransformEvent,
  OverlayViewportEvent,
  OverlayStyleEvent,
  BackgroundEvent,
  CanvasSizeEvent,
  BatchEvent,
  SubEvent,
} from '../../types';

// ========================================
// テストヘルパー
// ========================================

const SESSION = 'sess_local';
const OTHER_SESSION = 'sess_remote';

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

function makeOR(removeId: string, targetOverlayId: string, sessionId = SESSION): OverlayRemoveEvent {
  return { type: 'OR', timestamp: '2026-01-01T00:00:00.000Z', sessionId, removeId, targetOverlayId };
}

function makeOT(id: string, overlayId: string, dx: number, dy: number, sessionId = SESSION): OverlayTransformEvent {
  return { type: 'OT', timestamp: '2026-01-01T00:00:00.000Z', sessionId, id, overlayId, dx, dy };
}

function makeOV(id: string, overlayId: string, sessionId = SESSION): OverlayViewportEvent {
  return {
    type: 'OV', timestamp: '2026-01-01T00:00:00.000Z', sessionId, id, overlayId,
    dViewport: { dx: 10, dy: 20 }, dPage: 1,
  };
}

function makeOS(id: string, overlayId: string, dzIndex: number, sessionId = SESSION): OverlayStyleEvent {
  return { type: 'OS', timestamp: '2026-01-01T00:00:00.000Z', sessionId, id, overlayId, dzIndex };
}

function makeBG(id: string, sessionId = SESSION): BackgroundEvent {
  return {
    type: 'BG', timestamp: '2026-01-01T00:00:00.000Z', sessionId, id,
    dColor: { space: 'srgb', dr: -10, dg: -10, db: -10 },
    pattern: { prev: 'none', next: 'grid' },
  };
}

function makeCS(id: string, sessionId = SESSION): CanvasSizeEvent {
  return {
    type: 'CS', timestamp: '2026-01-01T00:00:00.000Z', sessionId, id,
    dCanvasWidth: 1920, dCanvasHeight: 1080,
  };
}

function makeBatch(id: string, subEvents: SubEvent[], sessionId = SESSION): BatchEvent {
  return { type: 'BATCH', id, timestamp: '2026-01-01T00:00:00.000Z', sessionId, events: subEvents };
}

// ========================================
// processSubEvent 単体テスト
// ========================================

describe('processSubEvent', () => {
  it('D → draw operation and updates strokeData', () => {
    const strokeData = new Map<string, DrawEvent>();
    const overlayData = new Map<string, OverlayAddEvent>();
    const d = makeD('s:001');
    const op = processSubEvent(d, strokeData, overlayData);

    expect(op).not.toBeNull();
    expect(op!.type).toBe('draw');
    expect(strokeData.has('s:001')).toBe(true);
  });

  it('E → erase operation when target exists', () => {
    const strokeData = new Map<string, DrawEvent>();
    const overlayData = new Map<string, OverlayAddEvent>();
    strokeData.set('s:001', makeD('s:001'));

    const e = makeE('e:001', 's:001');
    const op = processSubEvent(e, strokeData, overlayData);

    expect(op).not.toBeNull();
    expect(op!.type).toBe('erase');
    expect((op as any).targetId).toBe('s:001');
  });

  it('E → null when target does not exist', () => {
    const strokeData = new Map<string, DrawEvent>();
    const overlayData = new Map<string, OverlayAddEvent>();

    const e = makeE('e:001', 's:nonexistent');
    const op = processSubEvent(e, strokeData, overlayData);

    expect(op).toBeNull();
  });

  it('OA → overlayAdd operation', () => {
    const strokeData = new Map<string, DrawEvent>();
    const overlayData = new Map<string, OverlayAddEvent>();
    const oa = makeOA('o:001');
    const op = processSubEvent(oa, strokeData, overlayData);

    expect(op!.type).toBe('overlayAdd');
    expect(overlayData.has('o:001')).toBe(true);
  });

  it('OR → overlayRemove when target exists', () => {
    const strokeData = new Map<string, DrawEvent>();
    const overlayData = new Map<string, OverlayAddEvent>();
    overlayData.set('o:001', makeOA('o:001'));

    const or = makeOR('r:001', 'o:001');
    const op = processSubEvent(or, strokeData, overlayData);

    expect(op!.type).toBe('overlayRemove');
  });

  it('OR → null when target does not exist', () => {
    const strokeData = new Map<string, DrawEvent>();
    const overlayData = new Map<string, OverlayAddEvent>();

    const or = makeOR('r:001', 'o:nonexistent');
    const op = processSubEvent(or, strokeData, overlayData);

    expect(op).toBeNull();
  });

  it('OT → overlayTransform with defaults for missing deltas', () => {
    const strokeData = new Map<string, DrawEvent>();
    const overlayData = new Map<string, OverlayAddEvent>();
    const ot: OverlayTransformEvent = {
      type: 'OT', timestamp: '', sessionId: '', id: 'ot:001', overlayId: 'o:001', dx: 50,
    };
    const op = processSubEvent(ot, strokeData, overlayData)!;

    expect(op.type).toBe('overlayTransform');
    const t = op as any;
    expect(t.dx).toBe(50);
    expect(t.dy).toBe(0);
    expect(t.dWidth).toBe(0);
    expect(t.dHeight).toBe(0);
    expect(t.dRotation).toBe(0);
  });

  it('BG → background operation', () => {
    const strokeData = new Map<string, DrawEvent>();
    const overlayData = new Map<string, OverlayAddEvent>();
    const bg = makeBG('bg:001');
    const op = processSubEvent(bg, strokeData, overlayData)!;

    expect(op.type).toBe('background');
    expect((op as any).dColor).toBeDefined();
    expect((op as any).pattern).toBeDefined();
  });

  it('CS → canvasSize operation', () => {
    const strokeData = new Map<string, DrawEvent>();
    const overlayData = new Map<string, OverlayAddEvent>();
    const cs = makeCS('cs:001');
    const op = processSubEvent(cs, strokeData, overlayData)!;

    expect(op.type).toBe('canvasSize');
    expect((op as any).dCanvasWidth).toBe(1920);
  });
});

// ========================================
// buildUndoStack（同期版）
// ========================================

describe('buildUndoStack (sync)', () => {
  it('returns empty stack for empty events', () => {
    const stack = buildUndoStack([], SESSION);
    expect(stack).toHaveLength(0);
  });

  it('builds stack for draw events from matching session', () => {
    const events: WbelxEvent[] = [makeD('s:001'), makeD('s:002'), makeD('s:003')];
    const stack = buildUndoStack(events, SESSION);
    expect(stack).toHaveLength(3);
    expect(stack.every(op => op.type === 'draw')).toBe(true);
  });

  it('filters out events from other sessions (Local Undo)', () => {
    const events: WbelxEvent[] = [
      makeD('s:001', SESSION),
      makeD('s:002', OTHER_SESSION),
      makeD('s:003', SESSION),
    ];
    const stack = buildUndoStack(events, SESSION);
    expect(stack).toHaveLength(2);
    expect((stack[0] as any).strokeId).toBe('s:001');
    expect((stack[1] as any).strokeId).toBe('s:003');
  });

  it('builds erase operations with target stroke data', () => {
    const events: WbelxEvent[] = [
      makeD('s:001'),
      makeE('e:001', 's:001'),
    ];
    const stack = buildUndoStack(events, SESSION);
    expect(stack).toHaveLength(2);
    expect(stack[1].type).toBe('erase');
    expect((stack[1] as any).targetStroke.id).toBe('s:001');
  });

  it('erase for unknown stroke produces no operation', () => {
    const events: WbelxEvent[] = [
      makeE('e:001', 's:unknown'),
    ];
    const stack = buildUndoStack(events, SESSION);
    expect(stack).toHaveLength(0);
  });

  it('tracks overlay data across sessions for local OR', () => {
    // Remote user adds overlay, local user removes it
    const events: WbelxEvent[] = [
      makeOA('o:001', OTHER_SESSION),
      makeOR('r:001', 'o:001', SESSION),
    ];
    const stack = buildUndoStack(events, SESSION);
    // OA is from other session → not in local stack
    // OR is from local session → in stack (with target overlay data tracked from remote OA)
    expect(stack).toHaveLength(1);
    expect(stack[0].type).toBe('overlayRemove');
    expect((stack[0] as any).targetOverlay).toBeDefined();
  });

  it('handles all overlay event types', () => {
    const events: WbelxEvent[] = [
      makeOA('o:001'),
      makeOT('ot:001', 'o:001', 50, 30),
      makeOV('ov:001', 'o:001'),
      makeOS('os:001', 'o:001', 2),
    ];
    const stack = buildUndoStack(events, SESSION);
    expect(stack).toHaveLength(4);
    expect(stack[0].type).toBe('overlayAdd');
    expect(stack[1].type).toBe('overlayTransform');
    expect(stack[2].type).toBe('overlayViewport');
    expect(stack[3].type).toBe('overlayStyle');
  });

  it('handles BG and CS events', () => {
    const events: WbelxEvent[] = [
      makeBG('bg:001'),
      makeCS('cs:001'),
    ];
    const stack = buildUndoStack(events, SESSION);
    expect(stack).toHaveLength(2);
    expect(stack[0].type).toBe('background');
    expect(stack[1].type).toBe('canvasSize');
  });

  it('skips S (snapshot marker) events', () => {
    const events: WbelxEvent[] = [
      makeD('s:001'),
      { type: 'S', timestamp: '', sessionId: '', snapshotHash: 'sha256:test' },
      makeD('s:002'),
    ];
    const stack = buildUndoStack(events, SESSION);
    expect(stack).toHaveLength(2);
  });

  it('handles BATCH events from matching session', () => {
    const events: WbelxEvent[] = [
      makeD('s:001'),
      makeD('s:002'),
      makeBatch('b:001', [
        makeE('e:001', 's:001'),
        makeE('e:002', 's:002'),
      ]),
    ];
    const stack = buildUndoStack(events, SESSION);
    expect(stack).toHaveLength(3); // 2 draws + 1 batch
    expect(stack[2].type).toBe('batch');
    expect((stack[2] as any).operations).toHaveLength(2);
  });

  it('filters out BATCH from other session but still tracks data', () => {
    const events: WbelxEvent[] = [
      makeD('s:001', OTHER_SESSION),
      makeBatch('b:001', [
        makeE('e:001', 's:001', OTHER_SESSION),
      ], OTHER_SESSION),
    ];
    const stack = buildUndoStack(events, SESSION);
    expect(stack).toHaveLength(0); // Nothing from local session
  });

  it('BATCH with local sessionId: all sub-events included', () => {
    const events: WbelxEvent[] = [
      makeD('s:001'),
      makeBatch('b:001', [
        makeE('e:001', 's:001', SESSION),
        makeD('s:002', SESSION),
      ]),
    ];
    const stack = buildUndoStack(events, SESSION);
    expect(stack).toHaveLength(2);
    expect(stack[1].type).toBe('batch');
    expect((stack[1] as any).operations).toHaveLength(2);
  });

  it('large event stream builds correctly', () => {
    const events: WbelxEvent[] = [];
    for (let i = 0; i < 100; i++) {
      events.push(makeD(`s:${i}`, i % 3 === 0 ? OTHER_SESSION : SESSION));
    }
    const stack = buildUndoStack(events, SESSION);
    // i % 3 === 0: 0,3,6,...,99 → 34 items from OTHER_SESSION, 66 from SESSION
    expect(stack).toHaveLength(66);
  });
});

// ========================================
// buildUndoStackAsync（非同期版）
// ========================================

describe('buildUndoStackAsync', () => {
  it('produces same result as sync version', async () => {
    const events: WbelxEvent[] = [
      makeD('s:001'),
      makeD('s:002', OTHER_SESSION),
      makeOA('o:001'),
      makeOT('ot:001', 'o:001', 50, 30),
      makeBatch('b:001', [
        makeE('e:001', 's:001', SESSION),
        makeD('s:003', SESSION),
      ]),
      makeBG('bg:001'),
    ];

    const syncResult = buildUndoStack(events, SESSION);
    const asyncResult = await buildUndoStackAsync(events, SESSION, { chunkSize: 2 });

    expect(asyncResult).toHaveLength(syncResult.length);
    for (let i = 0; i < syncResult.length; i++) {
      expect(asyncResult[i].type).toBe(syncResult[i].type);
    }
  });

  it('supports abort via AbortSignal (returns partial result)', async () => {
    const events: WbelxEvent[] = [];
    for (let i = 0; i < 100; i++) {
      events.push(makeD(`s:${i}`));
    }

    const abort = new AbortController();
    abort.abort(); // Abort immediately

    const result = await buildUndoStackAsync(events, SESSION, {
      chunkSize: 1, // Check abort at every iteration
      signal: abort.signal,
    });
    // With chunkSize=1 and pre-aborted, first event is processed (i=0 skips yield check),
    // then at i=1 abort is detected → returns partial stack
    expect(result.length).toBeLessThan(100);
  });

  it('calls onProgress callback', async () => {
    const events: WbelxEvent[] = [];
    for (let i = 0; i < 10; i++) {
      events.push(makeD(`s:${i}`));
    }

    const progressCalls: [number, number][] = [];
    await buildUndoStackAsync(events, SESSION, {
      chunkSize: 3,
      onProgress: (processed, total) => progressCalls.push([processed, total]),
    });

    // With 10 events and chunkSize 3: progress at 3, 6, 9, then final 10
    expect(progressCalls.length).toBeGreaterThan(0);
    // Last call should be [10, 10]
    expect(progressCalls[progressCalls.length - 1]).toEqual([10, 10]);
  });

  it('handles empty events', async () => {
    const result = await buildUndoStackAsync([], SESSION);
    expect(result).toEqual([]);
  });
});
