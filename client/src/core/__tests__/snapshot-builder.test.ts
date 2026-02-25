import { describe, it, expect } from 'vitest';
import {
  buildSnapshotContent,
  buildBgCumulativeLine,
  buildCsCumulativeLine,
  flattenSnapshotContent,
} from '../snapshot-builder';
import type { WbelxState, DrawEvent, OverlayState, BackgroundState } from '../types';

function makeState(overrides: Partial<WbelxState> = {}): WbelxState {
  return {
    activeStrokeIds: new Set(),
    strokes: new Map(),
    activeOverlayIds: new Set(),
    overlays: new Map(),
    background: null,
    canvasWidth: 0,
    canvasHeight: 0,
    ...overrides,
  };
}

const stroke: DrawEvent = {
  type: 'D', timestamp: 'ts', sessionId: 'sid', id: 's:001',
  color: '#000', width: 2, bbox: [0, 0, 10, 10], path: 'M 0 0',
};

const overlay: OverlayState = {
  overlayId: 'o:001', assetUuid: 'a:001',
  x: 100, y: 200, width: 300, height: 200, rotation: 0,
  viewport: { x: 0, y: 0, width: 300, height: 200 },
  page: 1, zIndex: 1, opacity: 1.0,
};

describe('buildSnapshotContent', () => {
  it('builds snapshot with strokes and overlays', () => {
    const state = makeState({
      activeStrokeIds: new Set(['s:001']),
      strokes: new Map([['s:001', stroke]]),
      activeOverlayIds: new Set(['o:001']),
      overlays: new Map([['o:001', overlay]]),
    });
    const content = buildSnapshotContent(state, 'ts', 'sid', () => 'bg:1', () => 'cs:1');
    expect(content.drawEvents).toHaveLength(1);
    expect(content.overlayAddEvents).toHaveLength(1);
    expect(content.bgLine).toBeNull();
    expect(content.csLine).toBeNull();
  });

  it('includes BG cumulative line when background changed', () => {
    const bg: BackgroundState = {
      color: { r: 200, g: 200, b: 200 },
      pattern: 'grid',
      patternSize: 25,
      patternColor: { r: 224, g: 224, b: 224 },
    };
    const state = makeState({ background: bg });
    const content = buildSnapshotContent(state, 'ts', 'sid', () => 'bg:1', () => 'cs:1');
    expect(content.bgLine).not.toBeNull();
    expect(content.bgLine!.type).toBe('BG');
    expect(content.bgLine!.dColor).toEqual({ space: 'srgb', dr: -55, dg: -55, db: -55 });
    expect(content.bgLine!.pattern).toEqual({ prev: 'none', next: 'grid' });
    expect(content.bgLine!.dPatternSize).toBe(5);
  });

  it('includes CS cumulative line when canvas size set', () => {
    const state = makeState({ canvasWidth: 1920, canvasHeight: 1080 });
    const content = buildSnapshotContent(state, 'ts', 'sid', () => 'bg:1', () => 'cs:1');
    expect(content.csLine).not.toBeNull();
    expect(content.csLine!.dCanvasWidth).toBe(1920);
    expect(content.csLine!.dCanvasHeight).toBe(1080);
  });
});

describe('buildBgCumulativeLine', () => {
  it('returns null for null background', () => {
    expect(buildBgCumulativeLine(null, 'ts', 'sid', 'bg:1')).toBeNull();
  });

  it('returns null for default background', () => {
    const bg: BackgroundState = {
      color: { r: 255, g: 255, b: 255 },
      pattern: 'none',
      patternSize: 20,
      patternColor: { r: 224, g: 224, b: 224 },
    };
    expect(buildBgCumulativeLine(bg, 'ts', 'sid', 'bg:1')).toBeNull();
  });
});

describe('buildCsCumulativeLine', () => {
  it('returns null for 0x0 canvas', () => {
    expect(buildCsCumulativeLine(0, 0, 'ts', 'sid', 'cs:1')).toBeNull();
  });

  it('returns CS event for non-zero canvas', () => {
    const event = buildCsCumulativeLine(1920, 0, 'ts', 'sid', 'cs:1');
    expect(event).not.toBeNull();
    expect(event!.dCanvasWidth).toBe(1920);
    expect(event!.dCanvasHeight).toBeUndefined();
  });
});

describe('flattenSnapshotContent', () => {
  it('flattens all events in order', () => {
    const content = {
      drawEvents: [stroke],
      overlayAddEvents: [{
        type: 'OA' as const, timestamp: 'ts', sessionId: 'sid',
        overlayId: 'o:001', assetUuid: 'a:001',
        x: 0, y: 0, width: 100, height: 100, rotation: 0,
        viewport: { x: 0, y: 0, width: 0, height: 0 },
        page: 1, zIndex: 1, opacity: 1,
      }],
      bgLine: { type: 'BG' as const, timestamp: 'ts', sessionId: 'sid', id: 'bg:1', dPatternSize: 5 },
      csLine: { type: 'CS' as const, timestamp: 'ts', sessionId: 'sid', id: 'cs:1', dCanvasWidth: 1920 },
    };
    const flat = flattenSnapshotContent(content);
    expect(flat).toHaveLength(4);
    expect(flat[0].type).toBe('D');
    expect(flat[1].type).toBe('OA');
    expect(flat[2].type).toBe('BG');
    expect(flat[3].type).toBe('CS');
  });
});
