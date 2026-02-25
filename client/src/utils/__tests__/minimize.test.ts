import { describe, it, expect } from 'vitest';
import { minimizeWbelx } from '../../core/minimize';
import type { MinimizeDeps } from '../../core/minimize';
import { computeState } from '../../core/state-machine';
import { parseWbelx, parseWbelxWithHeader } from '../wbelx-parser';
import type {
  WbelxEvent,
  DrawEvent,
  EraseEvent,
  OverlayAddEvent,
  OverlayRemoveEvent,
  OverlayTransformEvent,
  OverlayStyleEvent,
  BackgroundEvent,
  BatchEvent,
  SubEvent,
} from '../../types';

// ========================================
// テスト用 DI deps
// ========================================

let bgIdCounter = 0;
const testDeps: MinimizeDeps = {
  getTimestamp: () => '2026-01-01T12:00:00.000Z',
  generateBgOpId: () => `bg:test-${++bgIdCounter}`,
};

// ========================================
// テストヘルパー
// ========================================

function makeD(id: string, path = 'M 0 0 L 10 10'): DrawEvent {
  return {
    type: 'D', timestamp: `2026-01-01T00:00:${id.slice(-2)}.000Z`, sessionId: 'sess1', id,
    color: '#000', width: 2, bbox: [0, 0, 10, 10], path,
  };
}

function makeE(id: string, targetId: string): EraseEvent {
  return { type: 'E', timestamp: '2026-01-01T00:00:10.000Z', sessionId: 'sess1', id, targetId };
}

function makeOA(overlayId: string, zIndex = 1): OverlayAddEvent {
  return {
    type: 'OA', timestamp: '2026-01-01T00:00:00.000Z', sessionId: 'sess1',
    overlayId, assetUuid: 'asset-001',
    x: 100, y: 200, width: 300, height: 200, rotation: 0,
    viewport: { x: 0, y: 0, width: 300, height: 200 },
    page: 1, zIndex, opacity: 1.0,
  };
}

function makeBatch(subEvents: SubEvent[]): BatchEvent {
  return {
    type: 'BATCH', id: `b:test`, timestamp: '2026-01-01T00:00:00.000Z', sessionId: 'sess1',
    events: subEvents,
  };
}

// ========================================
// 基本的な Minimize
// ========================================

describe('minimizeWbelx', () => {
  it('minimizes empty event list', () => {
    const result = minimizeWbelx([], testDeps);
    expect(result.afterEventCount).toBe(0);
    expect(result.activeStrokeCount).toBe(0);
    expect(result.activeOverlayCount).toBe(0);
    expect(result.hasBackground).toBe(false);
  });

  it('retains only active strokes', () => {
    const events: WbelxEvent[] = [
      makeD('s:001', 'M 0 0 L 100 100'),
      makeD('s:002', 'M 50 50 L 150 150'),
      makeE('e:001', 's:001'), // s:001 消去
    ];

    const result = minimizeWbelx(events, testDeps);
    expect(result.beforeEventCount).toBe(3);
    expect(result.activeStrokeCount).toBe(1);
    expect(result.afterEventCount).toBe(1); // s:002 のみ

    // 出力をパースして検証
    const parsed = parseWbelx(result.content);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].type).toBe('D');
    expect((parsed[0] as DrawEvent).id).toBe('s:002');
  });

  it('removes all E events', () => {
    const events: WbelxEvent[] = [
      makeD('s:001'),
      makeD('s:002'),
      makeE('e:001', 's:001'),
    ];

    const result = minimizeWbelx(events, testDeps);
    const parsed = parseWbelx(result.content);
    const types = parsed.map(e => e.type);
    expect(types).not.toContain('E');
  });

  it('retains active overlays as OA (absolute values)', () => {
    const events: WbelxEvent[] = [
      makeOA('o:001'),
      { type: 'OT', timestamp: '', sessionId: '', id: 'ot:001', overlayId: 'o:001', dx: 50, dy: 30 } as OverlayTransformEvent,
    ];

    const result = minimizeWbelx(events, testDeps);
    expect(result.activeOverlayCount).toBe(1);

    const parsed = parseWbelx(result.content);
    const oa = parsed.find(e => e.type === 'OA') as OverlayAddEvent;
    expect(oa).toBeDefined();
    // OA should have the transformed position (100+50=150, 200+30=230)
    expect(oa.x).toBe(150);
    expect(oa.y).toBe(230);
  });

  it('removes deleted overlays (OR applied)', () => {
    const events: WbelxEvent[] = [
      makeOA('o:001'),
      makeOA('o:002', 2),
      { type: 'OR', timestamp: '', sessionId: '', removeId: 'r:001', targetOverlayId: 'o:001' } as OverlayRemoveEvent,
    ];

    const result = minimizeWbelx(events, testDeps);
    expect(result.activeOverlayCount).toBe(1);

    const parsed = parseWbelx(result.content);
    const oas = parsed.filter(e => e.type === 'OA') as OverlayAddEvent[];
    expect(oas).toHaveLength(1);
    expect(oas[0].overlayId).toBe('o:002');
  });

  it('removes OT, OV, OS events (applied into OA)', () => {
    const events: WbelxEvent[] = [
      makeOA('o:001'),
      { type: 'OT', timestamp: '', sessionId: '', id: 'ot:001', overlayId: 'o:001', dx: 10 } as OverlayTransformEvent,
      { type: 'OV', timestamp: '', sessionId: '', id: 'ov:001', overlayId: 'o:001', dViewport: { dx: 5 } },
      { type: 'OS', timestamp: '', sessionId: '', id: 'os:001', overlayId: 'o:001', dOpacity: -0.3 } as OverlayStyleEvent,
    ];

    const result = minimizeWbelx(events, testDeps);
    const parsed = parseWbelx(result.content);
    const types = parsed.map(e => e.type);
    expect(types).not.toContain('OT');
    expect(types).not.toContain('OV');
    expect(types).not.toContain('OS');

    // Verify OA has accumulated values
    const oa = parsed.find(e => e.type === 'OA') as OverlayAddEvent;
    expect(oa.x).toBe(110); // 100 + 10
    expect(oa.viewport.x).toBe(5); // 0 + 5
    expect(oa.opacity).toBeCloseTo(0.7); // 1.0 - 0.3
  });

  it('includes BG event as cumulative delta from spec defaults', () => {
    const events: WbelxEvent[] = [
      {
        type: 'BG', timestamp: '', sessionId: '', id: 'bg:001',
        dColor: { space: 'srgb', dr: -229, dg: -229, db: -209 },
        pattern: { prev: 'none', next: 'grid' },
      } as BackgroundEvent,
    ];

    const result = minimizeWbelx(events, testDeps);
    expect(result.hasBackground).toBe(true);

    const parsed = parseWbelx(result.content);
    const bgEvent = parsed.find(e => e.type === 'BG') as BackgroundEvent;
    expect(bgEvent).toBeDefined();
    expect(bgEvent.pattern).toEqual({ prev: 'none', next: 'grid' });
  });

  it('does not include BG if background is null', () => {
    const events: WbelxEvent[] = [makeD('s:001')];
    const result = minimizeWbelx(events, testDeps);
    expect(result.hasBackground).toBe(false);
  });

  it('removes S (snapshot marker) events', () => {
    const events: WbelxEvent[] = [
      makeD('s:001'),
      { type: 'S', timestamp: '', sessionId: '', snapshotHash: 'sha256:test' },
    ];
    const result = minimizeWbelx(events, testDeps);
    const parsed = parseWbelx(result.content);
    const types = parsed.map(e => e.type);
    expect(types).not.toContain('S');
  });

  it('removes BATCH events (sub-events already applied)', () => {
    const events: WbelxEvent[] = [
      makeD('s:001'),
      makeD('s:002'),
      makeBatch([
        makeE('e:001', 's:001'),
        makeE('e:002', 's:002'),
      ]),
    ];

    const result = minimizeWbelx(events, testDeps);
    expect(result.activeStrokeCount).toBe(0);
    expect(result.afterEventCount).toBe(0);
  });

  it('preserves canvasWidth and canvasHeight', () => {
    const result = minimizeWbelx([], testDeps, 1920, 1080);
    const { header } = parseWbelxWithHeader(result.content);
    expect(header).not.toBeNull();
    expect(header!.canvasWidth).toBe(1920);
    expect(header!.canvasHeight).toBe(1080);
  });
});

// ========================================
// Minimize 結果の同値性テスト
// ========================================

describe('minimize equivalence (minimize result == original state)', () => {
  it('minimized state equals original state for strokes', () => {
    const events: WbelxEvent[] = [
      makeD('s:001', 'M 0 0 L 100 100'),
      makeD('s:002', 'M 10 10 L 20 20'),
      makeD('s:003', 'M 30 30 L 40 40'),
      makeE('e:001', 's:002'),
    ];

    const originalState = computeState(events);
    const result = minimizeWbelx(events, testDeps);
    const minimizedEvents = parseWbelx(result.content);
    const minimizedState = computeState(minimizedEvents);

    // Active stroke sets should match
    expect(minimizedState.activeStrokeIds.size).toBe(originalState.activeStrokeIds.size);
    for (const id of originalState.activeStrokeIds) {
      expect(minimizedState.activeStrokeIds.has(id)).toBe(true);
      expect(minimizedState.strokes.get(id)?.path).toBe(originalState.strokes.get(id)?.path);
    }
  });

  it('minimized state equals original state for overlays', () => {
    const events: WbelxEvent[] = [
      makeOA('o:001'),
      makeOA('o:002', 2),
      { type: 'OT', timestamp: '', sessionId: '', id: 'ot:001', overlayId: 'o:001', dx: 50, dy: -30 } as OverlayTransformEvent,
      { type: 'OS', timestamp: '', sessionId: '', id: 'os:001', overlayId: 'o:001', dzIndex: 3 } as OverlayStyleEvent,
    ];

    const originalState = computeState(events);
    const result = minimizeWbelx(events, testDeps);
    const minimizedEvents = parseWbelx(result.content);
    const minimizedState = computeState(minimizedEvents);

    expect(minimizedState.activeOverlayIds.size).toBe(originalState.activeOverlayIds.size);
    for (const id of originalState.activeOverlayIds) {
      const orig = originalState.overlays.get(id)!;
      const mini = minimizedState.overlays.get(id)!;
      expect(mini.x).toBe(orig.x);
      expect(mini.y).toBe(orig.y);
      expect(mini.width).toBe(orig.width);
      expect(mini.height).toBe(orig.height);
      expect(mini.zIndex).toBe(orig.zIndex);
      expect(mini.opacity).toBeCloseTo(orig.opacity);
    }
  });

  it('minimized state equals original state for background', () => {
    const events: WbelxEvent[] = [
      {
        type: 'BG', timestamp: '', sessionId: '', id: 'bg:001',
        dColor: { space: 'srgb', dr: -100, dg: -50, db: -25 },
        pattern: { prev: 'none', next: 'dots' },
        dPatternSize: -5,
      } as BackgroundEvent,
    ];

    const originalState = computeState(events);
    const result = minimizeWbelx(events, testDeps);
    const minimizedEvents = parseWbelx(result.content);
    const minimizedState = computeState(minimizedEvents);

    expect(minimizedState.background).toEqual(originalState.background);
  });

  it('complex scenario: mixed strokes, overlays, background', () => {
    const events: WbelxEvent[] = [
      makeD('s:001'),
      makeD('s:002'),
      makeD('s:003'),
      makeOA('o:001'),
      makeOA('o:002', 2),
      { type: 'OT', timestamp: '', sessionId: '', id: 'ot:001', overlayId: 'o:001', dx: 50, dy: 30 } as OverlayTransformEvent,
      makeE('e:001', 's:002'),
      {
        type: 'BG', timestamp: '', sessionId: '', id: 'bg:001',
        pattern: { prev: 'none', next: 'grid' },
      } as BackgroundEvent,
      makeBatch([
        makeE('e:002', 's:003'),
        { type: 'OR', timestamp: '', sessionId: 'sess1', removeId: 'r:001', targetOverlayId: 'o:002' } as OverlayRemoveEvent,
      ]),
    ];

    const originalState = computeState(events);
    const result = minimizeWbelx(events, testDeps);
    const minimizedEvents = parseWbelx(result.content);
    const minimizedState = computeState(minimizedEvents);

    // 1 active stroke (s:001), 1 active overlay (o:001), background set
    expect(minimizedState.activeStrokeIds.size).toBe(1);
    expect(minimizedState.activeStrokeIds.has('s:001')).toBe(true);
    expect(minimizedState.activeOverlayIds.size).toBe(1);
    expect(minimizedState.activeOverlayIds.has('o:001')).toBe(true);
    expect(minimizedState.overlays.get('o:001')!.x).toBe(originalState.overlays.get('o:001')!.x);
    expect(minimizedState.background).toEqual(originalState.background);

    // Event count should be drastically reduced
    expect(result.afterEventCount).toBeLessThan(result.beforeEventCount);
    expect(result.afterEventCount).toBe(3); // 1 D + 1 OA + 1 BG
  });
});
