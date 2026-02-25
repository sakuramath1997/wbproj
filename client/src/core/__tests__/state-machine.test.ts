/**
 * core/__tests__/state-machine.test.ts
 *
 * state-machine の追加エッジケーステスト。
 * utils/__tests__/statemachine.test.ts の基本テストを補完する。
 *
 * 重点項目:
 *   - 同一オーバーレイへの連続操作（OT/OV/OS の累積）
 *   - 非アクティブ要素に対する操作のスキップ
 *   - BATCH 内の BG/CS イベント
 *   - computeState の冪等性
 *   - OV の dPage/dViewport 部分適用
 */

import { describe, it, expect } from 'vitest';
import {
  computeState,
  getActiveStrokes,
  getActiveOverlays,
} from '../state-machine';
import type {
  DrawEvent,
  EraseEvent,
  OverlayAddEvent,
  OverlayTransformEvent,
  OverlayViewportEvent,
  OverlayStyleEvent,
  BackgroundEvent,
  CanvasSizeEvent,
  BatchEvent,
  WbelxEvent,
} from '../types';

// ========================================
// ヘルパー
// ========================================

const ts = '2026-01-01T00:00:00.000Z';
const sid = 'test';

function makeD(id: string): DrawEvent {
  return {
    type: 'D', timestamp: ts, sessionId: sid, id,
    color: '#000', width: 2, bbox: [0, 0, 100, 100], path: 'M 0 0 L 100 100',
  };
}

function makeOA(overlayId: string, overrides: Partial<OverlayAddEvent> = {}): OverlayAddEvent {
  return {
    type: 'OA', timestamp: ts, sessionId: sid,
    overlayId, assetUuid: 'asset-001',
    x: 100, y: 200, width: 300, height: 200, rotation: 0,
    viewport: { x: 0, y: 0, width: 300, height: 200 },
    page: 1, zIndex: 1, opacity: 1.0,
    ...overrides,
  };
}

// ========================================
// 同一オーバーレイへの連続操作
// ========================================

describe('state-machine: sequential operations on same overlay', () => {
  it('multiple OT events accumulate position', () => {
    const events: WbelxEvent[] = [
      makeOA('o:001'),
      { type: 'OT', timestamp: ts, sessionId: sid, id: 'ot:001', overlayId: 'o:001', dx: 10, dy: 20 },
      { type: 'OT', timestamp: ts, sessionId: sid, id: 'ot:002', overlayId: 'o:001', dx: 30, dy: -5 },
      { type: 'OT', timestamp: ts, sessionId: sid, id: 'ot:003', overlayId: 'o:001', dx: -15 },
    ];
    const state = computeState(events);
    const overlays = getActiveOverlays(state);
    expect(overlays[0].x).toBe(100 + 10 + 30 - 15); // 125
    expect(overlays[0].y).toBe(200 + 20 - 5);        // 215
  });

  it('multiple OS events accumulate zIndex and opacity', () => {
    const events: WbelxEvent[] = [
      makeOA('o:001', { zIndex: 5, opacity: 0.8 }),
      { type: 'OS', timestamp: ts, sessionId: sid, id: 'os:001', overlayId: 'o:001', dzIndex: 3 },
      { type: 'OS', timestamp: ts, sessionId: sid, id: 'os:002', overlayId: 'o:001', dOpacity: -0.3 },
      { type: 'OS', timestamp: ts, sessionId: sid, id: 'os:003', overlayId: 'o:001', dzIndex: -2, dOpacity: 0.1 },
    ];
    const state = computeState(events);
    const overlays = getActiveOverlays(state);
    expect(overlays[0].zIndex).toBe(5 + 3 - 2);       // 6
    expect(overlays[0].opacity).toBeCloseTo(0.8 - 0.3 + 0.1); // 0.6
  });

  it('multiple OV events accumulate viewport and page', () => {
    const events: WbelxEvent[] = [
      makeOA('o:001', { page: 1 }),
      {
        type: 'OV', timestamp: ts, sessionId: sid, id: 'ov:001', overlayId: 'o:001',
        dViewport: { dx: 10, dy: 20 },
        dPage: 2,
      } as OverlayViewportEvent,
      {
        type: 'OV', timestamp: ts, sessionId: sid, id: 'ov:002', overlayId: 'o:001',
        dViewport: { dWidth: 50, dHeight: -30 },
      } as OverlayViewportEvent,
    ];
    const state = computeState(events);
    const overlays = getActiveOverlays(state);
    expect(overlays[0].viewport.x).toBe(0 + 10);
    expect(overlays[0].viewport.y).toBe(0 + 20);
    expect(overlays[0].viewport.width).toBe(300 + 50);
    expect(overlays[0].viewport.height).toBe(200 - 30);
    expect(overlays[0].page).toBe(3); // 1 + 2
  });
});

// ========================================
// 非アクティブ要素への操作
// ========================================

describe('state-machine: operations on inactive elements', () => {
  it('OT on removed overlay is no-op', () => {
    const events: WbelxEvent[] = [
      makeOA('o:001'),
      { type: 'OR', timestamp: ts, sessionId: sid, removeId: 'r:001', targetOverlayId: 'o:001' },
      { type: 'OT', timestamp: ts, sessionId: sid, id: 'ot:001', overlayId: 'o:001', dx: 999 },
    ];
    const state = computeState(events);
    expect(getActiveOverlays(state)).toHaveLength(0);
    // o:001 のデータは strokes map に残るが activeOverlayIds には含まれない
    expect(state.activeOverlayIds.has('o:001')).toBe(false);
  });

  it('E on already-erased stroke is harmless', () => {
    const events: WbelxEvent[] = [
      makeD('s:001'),
      { type: 'E', timestamp: ts, sessionId: sid, id: 'e:001', targetId: 's:001' } as EraseEvent,
      { type: 'E', timestamp: ts, sessionId: sid, id: 'e:002', targetId: 's:001' } as EraseEvent,
    ];
    const state = computeState(events);
    expect(getActiveStrokes(state)).toHaveLength(0);
  });

  it('OS on nonexistent overlay is no-op', () => {
    const events: WbelxEvent[] = [
      { type: 'OS', timestamp: ts, sessionId: sid, id: 'os:001', overlayId: 'nonexistent', dzIndex: 5 } as OverlayStyleEvent,
    ];
    const state = computeState(events);
    expect(getActiveOverlays(state)).toHaveLength(0);
  });
});

// ========================================
// BATCH 内の BG/CS イベント
// ========================================

describe('state-machine: BATCH containing BG and CS', () => {
  it('BATCH with BG + CS applies both', () => {
    const events: WbelxEvent[] = [
      {
        type: 'BATCH', id: 'b:001', timestamp: ts, sessionId: sid,
        events: [
          {
            type: 'BG', timestamp: ts, sessionId: sid, id: 'bg:001',
            pattern: { prev: 'none', next: 'dots' },
          } as BackgroundEvent,
          {
            type: 'CS', timestamp: ts, sessionId: sid, id: 'cs:001',
            dCanvasWidth: 800, dCanvasHeight: 600,
          } as CanvasSizeEvent,
        ],
      } as BatchEvent,
    ];
    const state = computeState(events);
    expect(state.background?.pattern).toBe('dots');
    expect(state.canvasWidth).toBe(800);
    expect(state.canvasHeight).toBe(600);
  });
});

// ========================================
// computeState の冪等性
// ========================================

describe('state-machine: computeState idempotency', () => {
  it('computing state twice yields same result', () => {
    const events: WbelxEvent[] = [
      makeD('s:001'),
      makeD('s:002'),
      makeOA('o:001'),
      { type: 'OT', timestamp: ts, sessionId: sid, id: 'ot:001', overlayId: 'o:001', dx: 50 } as OverlayTransformEvent,
    ];

    const state1 = computeState(events);
    const state2 = computeState(events);

    expect(state1.activeStrokeIds.size).toBe(state2.activeStrokeIds.size);
    expect(state1.activeOverlayIds.size).toBe(state2.activeOverlayIds.size);
    expect(getActiveOverlays(state1)[0].x).toBe(getActiveOverlays(state2)[0].x);
  });

  it('empty events yield initial state', () => {
    const state = computeState([]);
    expect(state.activeStrokeIds.size).toBe(0);
    expect(state.overlays.size).toBe(0);
    expect(state.background).toBeNull();
    expect(state.canvasWidth).toBe(0);
    expect(state.canvasHeight).toBe(0);
  });
});

// ========================================
// OV: dPage / dViewport の部分適用
// ========================================

describe('state-machine: OV partial fields', () => {
  it('OV with only dPage (no dViewport) changes page only', () => {
    const events: WbelxEvent[] = [
      makeOA('o:001'),
      {
        type: 'OV', timestamp: ts, sessionId: sid, id: 'ov:001', overlayId: 'o:001',
        dPage: 3,
      } as OverlayViewportEvent,
    ];
    const state = computeState(events);
    const overlays = getActiveOverlays(state);
    expect(overlays[0].page).toBe(4); // 1 + 3
    expect(overlays[0].viewport).toEqual({ x: 0, y: 0, width: 300, height: 200 });
  });

  it('OV with only dViewport (no dPage) changes viewport only', () => {
    const events: WbelxEvent[] = [
      makeOA('o:001'),
      {
        type: 'OV', timestamp: ts, sessionId: sid, id: 'ov:001', overlayId: 'o:001',
        dViewport: { dx: 50, dy: 50 },
      } as OverlayViewportEvent,
    ];
    const state = computeState(events);
    const overlays = getActiveOverlays(state);
    expect(overlays[0].page).toBe(1); // 変化なし
    expect(overlays[0].viewport.x).toBe(50);
  });
});

// ========================================
// clamping の境界値テスト
// ========================================

describe('state-machine: clamping boundary values', () => {
  it('opacity clamped at exactly 0.0 and 1.0', () => {
    const events: WbelxEvent[] = [
      makeOA('o:001', { opacity: 0.5 }),
      { type: 'OS', timestamp: ts, sessionId: sid, id: 'os:001', overlayId: 'o:001', dOpacity: -1.0 } as OverlayStyleEvent,
    ];
    const state = computeState(events);
    expect(getActiveOverlays(state)[0].opacity).toBe(0.0);
  });

  it('canvas size does not go negative with large negative delta', () => {
    const events: WbelxEvent[] = [
      { type: 'CS', timestamp: ts, sessionId: sid, id: 'cs:001', dCanvasWidth: 100 } as CanvasSizeEvent,
      { type: 'CS', timestamp: ts, sessionId: sid, id: 'cs:002', dCanvasWidth: -999 } as CanvasSizeEvent,
    ];
    const state = computeState(events);
    expect(state.canvasWidth).toBe(0);
  });

  it('BG color channels clamped to [0, 255]', () => {
    const events: WbelxEvent[] = [
      {
        type: 'BG', timestamp: ts, sessionId: sid, id: 'bg:001',
        dColor: { space: 'srgb', dr: 999, dg: -999, db: 0 },
      } as BackgroundEvent,
    ];
    const state = computeState(events);
    const bg = state.background;
    expect(bg).not.toBeNull();
    const color = bg!.color;
    expect(color).not.toBeNull();
    expect(color!.r).toBe(255);
    expect(color!.g).toBe(0);
  });
});
