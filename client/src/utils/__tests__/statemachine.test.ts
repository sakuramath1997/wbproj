import { describe, it, expect } from 'vitest';
import {
  createInitialState,
  applyEvent,
  computeState,
  getActiveOverlays,
  backgroundStateToSnapshotBGEvent,
} from '../../core/state-machine';
import type {
  OverlayAddEvent,
  OverlayTransformEvent,
  OverlayViewportEvent,
  OverlayStyleEvent,
  OverlayRemoveEvent,
  BackgroundEvent,
  CanvasSizeEvent,
  DrawEvent,
  EraseEvent,
  BatchEvent,
  SubEvent,
} from '../../types';

// ========================================
// テストヘルパー
// ========================================

function makeOA(overrides: Partial<OverlayAddEvent> = {}): OverlayAddEvent {
  return {
    type: 'OA',
    timestamp: '2026-01-01T00:00:00.000Z',
    sessionId: 'test',
    overlayId: 'o:001',
    assetUuid: 'asset-001',
    x: 100, y: 200,
    width: 300, height: 200,
    rotation: 0,
    viewport: { x: 0, y: 0, width: 300, height: 200 },
    page: 1,
    zIndex: 1,
    opacity: 1.0,
    ...overrides,
  };
}

function makeD(id: string, overrides: Partial<DrawEvent> = {}): DrawEvent {
  return {
    type: 'D', timestamp: '', sessionId: 'test', id,
    color: '#000', width: 2, bbox: [0, 0, 10, 10], path: 'M 0 0 L 10 10',
    ...overrides,
  };
}

function makeBatch(subEvents: SubEvent[], overrides: Partial<BatchEvent> = {}): BatchEvent {
  return {
    type: 'BATCH',
    id: `b:test_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: '2026-01-01T00:00:00.000Z',
    sessionId: 'test',
    events: subEvents,
    ...overrides,
  };
}

// ========================================
// D / E イベント（v8 単一対象）
// ========================================

describe('D / E events', () => {
  it('D adds stroke to active set', () => {
    const d = makeD('s:001');
    const state = applyEvent(createInitialState(), d);
    expect(state.activeStrokeIds.has('s:001')).toBe(true);
    expect(state.strokes.get('s:001')).toEqual(d);
  });

  it('E removes single stroke from active set (v8 targetId)', () => {
    const d = makeD('s:001');
    const e: EraseEvent = {
      type: 'E', timestamp: '', sessionId: '', id: 'e:001', targetId: 's:001',
    };
    let state = applyEvent(createInitialState(), d);
    state = applyEvent(state, e);
    expect(state.activeStrokeIds.has('s:001')).toBe(false);
    expect(state.strokes.has('s:001')).toBe(true);
  });

  it('E for nonexistent stroke is harmless', () => {
    const e: EraseEvent = {
      type: 'E', timestamp: '', sessionId: '', id: 'e:001', targetId: 's:nonexistent',
    };
    const state = applyEvent(createInitialState(), e);
    expect(state.activeStrokeIds.size).toBe(0);
  });
});

// ========================================
// OA / OR イベント（v4 単一対象）
// ========================================

describe('OA / OR events', () => {
  it('OA creates overlay with absolute values', () => {
    const oa = makeOA();
    const state = applyEvent(createInitialState(), oa);
    expect(state.activeOverlayIds.has('o:001')).toBe(true);
    const o = state.overlays.get('o:001')!;
    expect(o.x).toBe(100);
    expect(o.y).toBe(200);
    expect(o.width).toBe(300);
    expect(o.height).toBe(200);
    expect(o.viewport).toEqual({ x: 0, y: 0, width: 300, height: 200 });
  });

  it('OR removes single overlay from active set (v4 targetOverlayId)', () => {
    const or: OverlayRemoveEvent = {
      type: 'OR', timestamp: '', sessionId: '',
      removeId: 'r:001', targetOverlayId: 'o:001',
    };
    let state = applyEvent(createInitialState(), makeOA());
    state = applyEvent(state, or);
    expect(state.activeOverlayIds.has('o:001')).toBe(false);
  });
});

// ========================================
// OT デルタ加算
// ========================================

describe('OT delta application', () => {
  it('adds dx, dy to position', () => {
    const ot: OverlayTransformEvent = {
      type: 'OT', timestamp: '', sessionId: '', id: 'ot:001',
      overlayId: 'o:001', dx: 50, dy: -30,
    };
    let state = applyEvent(createInitialState(), makeOA());
    state = applyEvent(state, ot);
    const o = state.overlays.get('o:001')!;
    expect(o.x).toBe(150);
    expect(o.y).toBe(170);
    expect(o.width).toBe(300);
    expect(o.height).toBe(200);
  });

  it('clamps width/height to >= 1', () => {
    const ot: OverlayTransformEvent = {
      type: 'OT', timestamp: '', sessionId: '', id: 'ot:001',
      overlayId: 'o:001', dWidth: -500, dHeight: -500,
    };
    let state = applyEvent(createInitialState(), makeOA());
    state = applyEvent(state, ot);
    const o = state.overlays.get('o:001')!;
    expect(o.width).toBe(1);
    expect(o.height).toBe(1);
  });

  it('accumulates rotation (no mod 360 in state)', () => {
    const ot1: OverlayTransformEvent = {
      type: 'OT', timestamp: '', sessionId: '', id: 'ot:001',
      overlayId: 'o:001', dRotation: 350,
    };
    const ot2: OverlayTransformEvent = {
      type: 'OT', timestamp: '', sessionId: '', id: 'ot:002',
      overlayId: 'o:001', dRotation: 20,
    };
    let state = applyEvent(createInitialState(), makeOA());
    state = applyEvent(state, ot1);
    state = applyEvent(state, ot2);
    expect(state.overlays.get('o:001')!.rotation).toBe(370);
  });

  it('ignores OT for nonexistent overlay', () => {
    const ot: OverlayTransformEvent = {
      type: 'OT', timestamp: '', sessionId: '', id: 'ot:001',
      overlayId: 'o:nonexistent', dx: 50,
    };
    const state = applyEvent(createInitialState(), ot);
    expect(state.overlays.size).toBe(0);
  });
});

// ========================================
// OV デルタ加算
// ========================================

describe('OV delta application', () => {
  it('adds dViewport to viewport', () => {
    const ov: OverlayViewportEvent = {
      type: 'OV', timestamp: '', sessionId: '', id: 'ov:001',
      overlayId: 'o:001',
      dViewport: { dx: 10, dy: 20, dWidth: -50, dHeight: 50 },
    };
    let state = applyEvent(createInitialState(), makeOA());
    state = applyEvent(state, ov);
    expect(state.overlays.get('o:001')!.viewport).toEqual({ x: 10, y: 20, width: 250, height: 250 });
  });

  it('clamps viewport width/height to >= 1', () => {
    const ov: OverlayViewportEvent = {
      type: 'OV', timestamp: '', sessionId: '', id: 'ov:001',
      overlayId: 'o:001',
      dViewport: { dWidth: -1000 },
    };
    let state = applyEvent(createInitialState(), makeOA());
    state = applyEvent(state, ov);
    expect(state.overlays.get('o:001')!.viewport.width).toBe(1);
  });

  it('clamps page to >= 1', () => {
    const ov: OverlayViewportEvent = {
      type: 'OV', timestamp: '', sessionId: '', id: 'ov:001',
      overlayId: 'o:001', dPage: -5,
    };
    let state = applyEvent(createInitialState(), makeOA());
    state = applyEvent(state, ov);
    expect(state.overlays.get('o:001')!.page).toBe(1);
  });
});

// ========================================
// OS デルタ加算（v4 単一ターゲット）
// ========================================

describe('OS delta application (v4 single-target)', () => {
  it('adds dzIndex and dOpacity', () => {
    const os: OverlayStyleEvent = {
      type: 'OS', timestamp: '', sessionId: '', id: 'os:001',
      overlayId: 'o:001', dzIndex: 2, dOpacity: -0.3,
    };
    let state = applyEvent(createInitialState(), makeOA());
    state = applyEvent(state, os);
    const o = state.overlays.get('o:001')!;
    expect(o.zIndex).toBe(3);
    expect(o.opacity).toBeCloseTo(0.7);
  });

  it('clamps zIndex to >= 1', () => {
    const os: OverlayStyleEvent = {
      type: 'OS', timestamp: '', sessionId: '', id: 'os:001',
      overlayId: 'o:001', dzIndex: -10,
    };
    let state = applyEvent(createInitialState(), makeOA());
    state = applyEvent(state, os);
    expect(state.overlays.get('o:001')!.zIndex).toBe(1);
  });

  it('clamps opacity to [0, 1]', () => {
    const os: OverlayStyleEvent = {
      type: 'OS', timestamp: '', sessionId: '', id: 'os:001',
      overlayId: 'o:001', dOpacity: 5,
    };
    let state = applyEvent(createInitialState(), makeOA());
    state = applyEvent(state, os);
    expect(state.overlays.get('o:001')!.opacity).toBe(1.0);
  });

  it('handles zIndex swap via BATCH of two OS events', () => {
    const oa1 = makeOA({ overlayId: 'o:001', zIndex: 1 });
    const oa2 = makeOA({ overlayId: 'o:002', zIndex: 2 });
    const batch = makeBatch([
      { type: 'OS', timestamp: '', sessionId: '', id: 'os:001', overlayId: 'o:001', dzIndex: +1 },
      { type: 'OS', timestamp: '', sessionId: '', id: 'os:002', overlayId: 'o:002', dzIndex: -1 },
    ]);
    let state = createInitialState();
    state = applyEvent(state, oa1);
    state = applyEvent(state, oa2);
    state = applyEvent(state, batch);
    expect(state.overlays.get('o:001')!.zIndex).toBe(2);
    expect(state.overlays.get('o:002')!.zIndex).toBe(1);
  });
});

// ========================================
// BG デルタ加算
// ========================================

describe('BG delta application', () => {
  it('initializes from spec defaults on first BG event', () => {
    const bg: BackgroundEvent = {
      type: 'BG', timestamp: '', sessionId: '', id: 'bg:001',
      dColor: { space: 'srgb', dr: -255, dg: -255, db: -255 },
    };
    let state = createInitialState();
    expect(state.background).toBeNull();
    state = applyEvent(state, bg);
    expect(state.background).not.toBeNull();
    expect(state.background!.color).toEqual({ r: 0, g: 0, b: 0 });
    expect(state.background!.pattern).toBe('none');
    expect(state.background!.patternSize).toBe(20);
    expect(state.background!.patternColor).toEqual({ r: 224, g: 224, b: 224 });
  });

  it('clamps color channels to [0, 255]', () => {
    const bg: BackgroundEvent = {
      type: 'BG', timestamp: '', sessionId: '', id: 'bg:001',
      dColor: { space: 'srgb', dr: 100, dg: -300, db: 0 },
    };
    const state = applyEvent(createInitialState(), bg);
    expect(state.background!.color).toEqual({ r: 255, g: 0, b: 255 });
  });

  it('applies pattern enum via next field', () => {
    const bg: BackgroundEvent = {
      type: 'BG', timestamp: '', sessionId: '', id: 'bg:001',
      pattern: { prev: 'none', next: 'grid' },
    };
    const state = applyEvent(createInitialState(), bg);
    expect(state.background!.pattern).toBe('grid');
  });

  it('accumulates multiple BG events', () => {
    const bg1: BackgroundEvent = {
      type: 'BG', timestamp: '', sessionId: '', id: 'bg:001',
      dColor: { space: 'srgb', dr: -100, dg: -100, db: -100 },
    };
    const bg2: BackgroundEvent = {
      type: 'BG', timestamp: '', sessionId: '', id: 'bg:002',
      dColor: { space: 'srgb', dr: -50, dg: -50, db: -50 },
    };
    let state = createInitialState();
    state = applyEvent(state, bg1);
    state = applyEvent(state, bg2);
    expect(state.background!.color).toEqual({ r: 105, g: 105, b: 105 });
  });

  it('clamps patternSize to >= 1', () => {
    const bg: BackgroundEvent = {
      type: 'BG', timestamp: '', sessionId: '', id: 'bg:001',
      dPatternSize: -100,
    };
    const state = applyEvent(createInitialState(), bg);
    expect(state.background!.patternSize).toBe(1);
  });
});

// ========================================
// CS（Canvas Size）イベント
// ========================================

describe('CS (Canvas Size) event', () => {
  it('初期状態は canvasWidth=0, canvasHeight=0', () => {
    const state = createInitialState();
    expect(state.canvasWidth).toBe(0);
    expect(state.canvasHeight).toBe(0);
  });

  it('CS イベントでデルタ加算', () => {
    const cs: CanvasSizeEvent = {
      type: 'CS', timestamp: '', sessionId: 'sess1', id: 'cs:001',
      dCanvasWidth: 1920, dCanvasHeight: 1080,
    };
    const state = applyEvent(createInitialState(), cs);
    expect(state.canvasWidth).toBe(1920);
    expect(state.canvasHeight).toBe(1080);
  });

  it('複数 CS イベントでデルタが累積', () => {
    const events = [
      { type: 'CS' as const, timestamp: '', sessionId: 'sess1', id: 'cs:001', dCanvasWidth: 1920, dCanvasHeight: 1080 },
      { type: 'CS' as const, timestamp: '', sessionId: 'sess1', id: 'cs:002', dCanvasWidth: 640 },
    ];
    const state = computeState(events);
    expect(state.canvasWidth).toBe(2560);
    expect(state.canvasHeight).toBe(1080);
  });

  it('clamp: 負のデルタで 0 以下にならない', () => {
    const events = [
      { type: 'CS' as const, timestamp: '', sessionId: 'sess1', id: 'cs:001', dCanvasWidth: 1920, dCanvasHeight: 1080 },
      { type: 'CS' as const, timestamp: '', sessionId: 'sess1', id: 'cs:002', dCanvasWidth: -3000, dCanvasHeight: -1080 },
    ];
    const state = computeState(events);
    expect(state.canvasWidth).toBe(0);
    expect(state.canvasHeight).toBe(0);
  });
});

// ========================================
// BATCH イベント
// ========================================

describe('BATCH event', () => {
  it('applies all sub-events sequentially', () => {
    const batch = makeBatch([
      makeD('s:001'),
      makeD('s:002'),
      makeD('s:003'),
    ]);
    const state = applyEvent(createInitialState(), batch);
    expect(state.activeStrokeIds.size).toBe(3);
    expect(state.strokes.size).toBe(3);
  });

  it('handles mixed E + D sub-events (lasso move)', () => {
    let state = createInitialState();
    state = applyEvent(state, makeD('s:001'));
    state = applyEvent(state, makeD('s:002'));
    expect(state.activeStrokeIds.size).toBe(2);

    const batch = makeBatch([
      { type: 'E', timestamp: '', sessionId: 'test', id: 'e:001', targetId: 's:001' },
      { type: 'E', timestamp: '', sessionId: 'test', id: 'e:002', targetId: 's:002' },
      makeD('s:003', { path: 'M 10 10 L 20 20' }),
      makeD('s:004', { path: 'M 30 30 L 40 40' }),
    ]);
    state = applyEvent(state, batch);
    expect(state.activeStrokeIds.has('s:001')).toBe(false);
    expect(state.activeStrokeIds.has('s:002')).toBe(false);
    expect(state.activeStrokeIds.has('s:003')).toBe(true);
    expect(state.activeStrokeIds.has('s:004')).toBe(true);
    expect(state.activeStrokeIds.size).toBe(2);
  });

  it('handles cross-domain BATCH (stroke E + D + overlay OT)', () => {
    let state = createInitialState();
    state = applyEvent(state, makeD('s:001'));
    state = applyEvent(state, makeOA({ overlayId: 'o:001', x: 0, y: 0 }));

    const batch = makeBatch([
      { type: 'E', timestamp: '', sessionId: 'test', id: 'e:001', targetId: 's:001' },
      makeD('s:002', { path: 'M 50 50 L 60 60' }),
      { type: 'OT', timestamp: '', sessionId: 'test', id: 'ot:001', overlayId: 'o:001', dx: 50, dy: 30 },
    ]);
    state = applyEvent(state, batch);

    expect(state.activeStrokeIds.has('s:001')).toBe(false);
    expect(state.activeStrokeIds.has('s:002')).toBe(true);
    expect(state.overlays.get('o:001')!.x).toBe(50);
    expect(state.overlays.get('o:001')!.y).toBe(30);
  });

  it('multiple OR in BATCH removes multiple overlays', () => {
    let state = createInitialState();
    state = applyEvent(state, makeOA({ overlayId: 'o:001' }));
    state = applyEvent(state, makeOA({ overlayId: 'o:002', zIndex: 2 }));
    state = applyEvent(state, makeOA({ overlayId: 'o:003', zIndex: 3 }));
    expect(state.activeOverlayIds.size).toBe(3);

    const batch = makeBatch([
      { type: 'OR', timestamp: '', sessionId: 'test', removeId: 'r:001', targetOverlayId: 'o:001' },
      { type: 'OR', timestamp: '', sessionId: 'test', removeId: 'r:002', targetOverlayId: 'o:003' },
    ]);
    state = applyEvent(state, batch);
    expect(state.activeOverlayIds.size).toBe(1);
    expect(state.activeOverlayIds.has('o:002')).toBe(true);
  });

  it('S event in stream is ignored', () => {
    const events = [
      makeD('s:001'),
      { type: 'S' as const, timestamp: '', sessionId: '', snapshotHash: 'sha256:test' },
      makeD('s:002'),
    ];
    const state = computeState(events);
    expect(state.activeStrokeIds.size).toBe(2);
  });
});

// ========================================
// zIndex 正規化フォールバック
// ========================================

describe('zIndex normalization', () => {
  it('normalizes duplicate zIndex values', () => {
    const oa1 = makeOA({ overlayId: 'o:aaa', zIndex: 1 });
    const oa2 = makeOA({ overlayId: 'o:bbb', zIndex: 1 });
    const state = computeState([oa1, oa2]);
    expect(state.overlays.get('o:aaa')!.zIndex).toBe(1);
    expect(state.overlays.get('o:bbb')!.zIndex).toBe(2);
  });

  it('does not normalize when zIndex is unique', () => {
    const oa1 = makeOA({ overlayId: 'o:aaa', zIndex: 5 });
    const oa2 = makeOA({ overlayId: 'o:bbb', zIndex: 10 });
    const state = computeState([oa1, oa2]);
    expect(state.overlays.get('o:aaa')!.zIndex).toBe(5);
    expect(state.overlays.get('o:bbb')!.zIndex).toBe(10);
  });
});

// ========================================
// スナップショット BG イベント生成
// ========================================

describe('backgroundStateToSnapshotBGEvent', () => {
  it('returns null for null background', () => {
    expect(backgroundStateToSnapshotBGEvent(null, '', '', 'bg:snap')).toBeNull();
  });

  it('generates cumulative delta from spec defaults', () => {
    const bg = {
      color: { r: 26, g: 26, b: 46 },
      pattern: 'grid' as const,
      patternSize: 15,
      patternColor: { r: 234, g: 234, b: 234 },
    };
    const event = backgroundStateToSnapshotBGEvent(bg, '', '', 'bg:snap')!;
    expect(event.type).toBe('BG');
    expect(event.dColor).toEqual({ space: 'srgb', dr: 26 - 255, dg: 26 - 255, db: 46 - 255 });
    expect(event.pattern).toEqual({ prev: 'none', next: 'grid' });
    expect(event.dPatternSize).toBe(15 - 20);
  });

  it('roundtrips: snapshot BG → applyEvent yields same state', () => {
    const bg1: BackgroundEvent = {
      type: 'BG', timestamp: '', sessionId: '', id: 'bg:001',
      dColor: { space: 'srgb', dr: -229, dg: -229, db: -209 },
      pattern: { prev: 'none', next: 'grid' },
      dPatternSize: -5,
      dPatternColor: { space: 'srgb', dr: 10, dg: 10, db: 10 },
    };
    const state1 = applyEvent(createInitialState(), bg1);
    const snapEvent = backgroundStateToSnapshotBGEvent(state1.background, '', '', 'bg:snap')!;
    const state2 = applyEvent(createInitialState(), snapEvent);
    expect(state2.background).toEqual(state1.background);
  });
});

// ========================================
// computeState 統合テスト（v4）
// ========================================

describe('computeState integration (v4)', () => {
  it('processes mixed event stream with BATCH', () => {
    const events = [
      makeOA({ overlayId: 'o:001', x: 0, y: 0, width: 100, height: 100, zIndex: 1 }),
      makeOA({ overlayId: 'o:002', x: 50, y: 50, width: 200, height: 200, zIndex: 2 }),
      {
        type: 'OT' as const, timestamp: '', sessionId: '', id: 'ot:001',
        overlayId: 'o:001', dx: 10, dy: 20,
      },
      makeBatch([
        { type: 'OS', timestamp: '', sessionId: '', id: 'os:001', overlayId: 'o:001', dzIndex: +1 },
        { type: 'OS', timestamp: '', sessionId: '', id: 'os:002', overlayId: 'o:002', dzIndex: -1 },
      ]),
      {
        type: 'BG' as const, timestamp: '', sessionId: '', id: 'bg:001',
        pattern: { prev: 'none' as const, next: 'dots' as const },
      },
    ];
    const state = computeState(events);

    expect(state.overlays.get('o:001')!.x).toBe(10);
    expect(state.overlays.get('o:001')!.y).toBe(20);
    expect(state.overlays.get('o:001')!.zIndex).toBe(2);
    expect(state.overlays.get('o:002')!.zIndex).toBe(1);
    expect(state.background!.pattern).toBe('dots');

    const sorted = getActiveOverlays(state);
    expect(sorted[0].overlayId).toBe('o:002');
    expect(sorted[1].overlayId).toBe('o:001');
  });

  it('full lifecycle: draw, BATCH erase, BATCH lasso move', () => {
    const events = [
      makeD('s:001'),
      makeD('s:002'),
      makeD('s:003'),
      makeBatch([
        { type: 'E', timestamp: '', sessionId: 'test', id: 'e:001', targetId: 's:001' },
        { type: 'E', timestamp: '', sessionId: 'test', id: 'e:002', targetId: 's:002' },
      ]),
      makeBatch([
        { type: 'E', timestamp: '', sessionId: 'test', id: 'e:003', targetId: 's:003' },
        makeD('s:004', { path: 'M 100 100' }),
      ]),
    ];
    const state = computeState(events);
    expect(state.activeStrokeIds.size).toBe(1);
    expect(state.activeStrokeIds.has('s:004')).toBe(true);
    expect(state.strokes.size).toBe(4);
  });
});
