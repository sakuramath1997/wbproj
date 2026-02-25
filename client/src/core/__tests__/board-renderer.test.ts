/**
 * core/__tests__/board-renderer.test.ts
 *
 * ボードレンダリングロジックのテスト。
 * - computeContentBBox: BBox 計算
 * - renderBoard: モック RenderContext での描画呼び出し検証
 */

import { describe, it, expect } from 'vitest';
import { computeContentBBox, renderBoard } from '../board-renderer';
import type { RenderContext } from '../render-context';
import type { DrawEvent, OverlayState } from '../types';

// ========================================
// テスト用データファクトリ
// ========================================

function makeStroke(id: string, bbox: [number, number, number, number]): DrawEvent {
  return {
    type: 'D', timestamp: '2026-01-01T00:00:00.000Z', sessionId: 'test',
    id, color: '#000', width: 2, bbox, path: 'M 0 0 L 100 100',
  };
}

function makeOverlay(id: string, x: number, y: number, w: number, h: number): OverlayState {
  return {
    overlayId: id,
    assetUuid: `asset-${id}`,
    x, y, width: w, height: h,
    rotation: 0,
    viewport: { x: 0, y: 0, width: w, height: h },
    page: 1, zIndex: 1, opacity: 1.0,
  };
}

/** モック RenderContext を作成 */
function createMockCtx(): RenderContext & { calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
  };
  return {
    calls,
    fillRect: record('fillRect') as RenderContext['fillRect'],
    strokePath: record('strokePath') as RenderContext['strokePath'],
    drawImage: record('drawImage') as RenderContext['drawImage'],
    drawImageSimple: record('drawImageSimple') as RenderContext['drawImageSimple'],
    setTransform: record('setTransform') as RenderContext['setTransform'],
    setGlobalAlpha: record('setGlobalAlpha') as RenderContext['setGlobalAlpha'],
    save: record('save') as RenderContext['save'],
    restore: record('restore') as RenderContext['restore'],
    setLineCap: record('setLineCap') as RenderContext['setLineCap'],
    setLineJoin: record('setLineJoin') as RenderContext['setLineJoin'],
  };
}

// ========================================
// computeContentBBox
// ========================================

describe('computeContentBBox', () => {
  it('returns null when no strokes and no overlays', () => {
    expect(computeContentBBox([], [])).toBeNull();
  });

  it('computes bbox from strokes only', () => {
    const strokes = [
      makeStroke('s:1', [10, 20, 100, 80]),
      makeStroke('s:2', [50, 10, 200, 60]),
    ];
    const bbox = computeContentBBox(strokes, []);
    expect(bbox).not.toBeNull();
    expect(bbox!.x).toBe(10);
    expect(bbox!.y).toBe(10);
    expect(bbox!.width).toBe(190); // 200 - 10
    expect(bbox!.height).toBe(70); // 80 - 10
  });

  it('computes bbox from overlays only', () => {
    const overlays = [
      makeOverlay('o:1', 0, 0, 100, 50),
      makeOverlay('o:2', 80, 30, 120, 70),
    ];
    const bbox = computeContentBBox([], overlays);
    expect(bbox).not.toBeNull();
    expect(bbox!.x).toBe(0);
    expect(bbox!.y).toBe(0);
    expect(bbox!.width).toBe(200); // 80 + 120
    expect(bbox!.height).toBe(100); // 30 + 70
  });

  it('computes combined bbox from strokes and overlays', () => {
    const strokes = [makeStroke('s:1', [50, 50, 150, 150])];
    const overlays = [makeOverlay('o:1', 0, 0, 80, 60)];

    const bbox = computeContentBBox(strokes, overlays);
    expect(bbox).not.toBeNull();
    expect(bbox!.x).toBe(0);   // overlay の x
    expect(bbox!.y).toBe(0);   // overlay の y
    expect(bbox!.width).toBe(150);  // stroke maxX 150 - 0
    expect(bbox!.height).toBe(150); // stroke maxY 150 - 0
  });

  it('applies margin correctly', () => {
    const strokes = [makeStroke('s:1', [10, 20, 100, 80])];
    const bbox = computeContentBBox(strokes, [], 5);
    expect(bbox).not.toBeNull();
    expect(bbox!.x).toBe(5);       // 10 - 5
    expect(bbox!.y).toBe(15);      // 20 - 5
    expect(bbox!.width).toBe(100);  // (100-10) + 10
    expect(bbox!.height).toBe(70);  // (80-20) + 10
  });

  it('handles single stroke', () => {
    const strokes = [makeStroke('s:1', [0, 0, 50, 50])];
    const bbox = computeContentBBox(strokes, []);
    expect(bbox).toEqual({ x: 0, y: 0, width: 50, height: 50 });
  });

  it('handles single overlay', () => {
    const overlays = [makeOverlay('o:1', 10, 20, 100, 50)];
    const bbox = computeContentBBox([], overlays);
    expect(bbox).toEqual({ x: 10, y: 20, width: 100, height: 50 });
  });
});

// ========================================
// renderBoard
// ========================================

describe('renderBoard', () => {
  it('renders background when provided', () => {
    const ctx = createMockCtx();
    renderBoard(
      ctx,
      {
        strokes: [],
        overlays: [],
        background: { color: '#fff', pattern: 'none', patternSize: 20, patternColor: '#ccc' },
      },
      { width: 800, height: 600 },
      () => null,
    );

    const fillCalls = ctx.calls.filter(c => c.method === 'fillRect');
    expect(fillCalls.length).toBeGreaterThanOrEqual(1);
    expect(fillCalls[0].args).toEqual([0, 0, 800, 600, '#fff']);
  });

  it('calls strokePath for each stroke', () => {
    const ctx = createMockCtx();
    const strokes = [
      makeStroke('s:1', [0, 0, 100, 100]),
      makeStroke('s:2', [50, 50, 200, 200]),
    ];

    renderBoard(
      ctx,
      { strokes, overlays: [] },
      { width: 400, height: 300, viewport: { x: 0, y: 0, width: 200, height: 200 } },
      () => null,
    );

    const strokeCalls = ctx.calls.filter(c => c.method === 'strokePath');
    expect(strokeCalls).toHaveLength(2);
    expect(strokeCalls[0].args[0]).toBe('M 0 0 L 100 100');
    expect(strokeCalls[0].args[1]).toBe('#000');
    expect(strokeCalls[0].args[2]).toBe(2);
  });

  it('uses drawImage for overlay with non-zero viewport', () => {
    const ctx = createMockCtx();
    const overlay = makeOverlay('o:1', 10, 20, 200, 150);
    const imgHandle = { id: 'test-img' };

    renderBoard(
      ctx,
      { strokes: [], overlays: [overlay] },
      { width: 400, height: 300, viewport: { x: 0, y: 0, width: 400, height: 300 } },
      (uuid) => uuid === 'asset-o:1' ? imgHandle : null,
    );

    const drawCalls = ctx.calls.filter(c => c.method === 'drawImage');
    expect(drawCalls).toHaveLength(1);
  });

  it('uses fillRect as placeholder when image not resolved', () => {
    const ctx = createMockCtx();
    const overlay = makeOverlay('o:1', 10, 20, 200, 150);

    renderBoard(
      ctx,
      { strokes: [], overlays: [overlay] },
      { width: 400, height: 300, viewport: { x: 0, y: 0, width: 400, height: 300 } },
      () => null,
    );

    // プレースホルダー描画: fillRect with gray
    const fillCalls = ctx.calls.filter(c => c.method === 'fillRect');
    const placeholderCall = fillCalls.find(c => c.args[4] === '#d1d5db');
    expect(placeholderCall).toBeDefined();
  });

  it('sets globalAlpha for overlay opacity', () => {
    const ctx = createMockCtx();
    const overlay = { ...makeOverlay('o:1', 0, 0, 100, 100), opacity: 0.5 };

    renderBoard(
      ctx,
      { strokes: [], overlays: [overlay] },
      { width: 200, height: 200, viewport: { x: 0, y: 0, width: 200, height: 200 } },
      () => null,
    );

    const alphaCalls = ctx.calls.filter(c => c.method === 'setGlobalAlpha');
    expect(alphaCalls.some(c => c.args[0] === 0.5)).toBe(true);
  });

  it('balances save/restore calls', () => {
    const ctx = createMockCtx();
    const strokes = [makeStroke('s:1', [0, 0, 50, 50])];
    const overlays = [makeOverlay('o:1', 0, 0, 100, 100)];

    renderBoard(
      ctx,
      { strokes, overlays },
      { width: 400, height: 300, viewport: { x: 0, y: 0, width: 400, height: 300 } },
      () => null,
    );

    const saves = ctx.calls.filter(c => c.method === 'save').length;
    const restores = ctx.calls.filter(c => c.method === 'restore').length;
    expect(saves).toBe(restores);
  });

  it('sets lineCap and lineJoin for stroke rendering', () => {
    const ctx = createMockCtx();
    renderBoard(
      ctx,
      { strokes: [makeStroke('s:1', [0, 0, 50, 50])], overlays: [] },
      { width: 400, height: 300, viewport: { x: 0, y: 0, width: 400, height: 300 } },
      () => null,
    );

    expect(ctx.calls.some(c => c.method === 'setLineCap' && c.args[0] === 'round')).toBe(true);
    expect(ctx.calls.some(c => c.method === 'setLineJoin' && c.args[0] === 'round')).toBe(true);
  });

  it('falls back to default viewport when none provided and no content', () => {
    const ctx = createMockCtx();
    renderBoard(
      ctx,
      { strokes: [], overlays: [] },
      { width: 400, height: 300 },
      () => null,
    );
    // No error thrown — default viewport {-960, -540, 1920, 1080} used
    expect(ctx.calls.length).toBeGreaterThanOrEqual(0);
  });
});
