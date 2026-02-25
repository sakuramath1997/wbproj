import { describe, it, expect, beforeEach } from 'vitest';
import {
  computeLassoBBox,
  extractLassoSelectedData,
  buildLassoMoveData,
  buildLassoDeleteData,
  buildLassoCreateData,
} from '../lasso-engine';
import type { DrawEvent, OverlayState } from '../types';

function makeStroke(id: string, bbox: [number, number, number, number]): DrawEvent {
  return { type: 'D', timestamp: '', sessionId: '', id, color: '#000', width: 2, bbox, path: 'M 0 0' };
}

function makeOverlay(id: string, x: number, y: number, w: number, h: number): OverlayState {
  return {
    overlayId: id, assetUuid: 'a:001', x, y, width: w, height: h,
    rotation: 0, viewport: { x: 0, y: 0, width: 0, height: 0 },
    page: 1, zIndex: 1, opacity: 1.0,
  };
}

let idCounter = 0;
const mockIds = {
  generateEraseId: () => `e:${idCounter++}`,
  generateRemoveId: () => `rm:${idCounter++}`,
  generateTransformOpId: () => `ot:${idCounter++}`,
  generateStrokeId: () => `s:${idCounter++}`,
  generateOverlayId: () => `o:${idCounter++}`,
};

beforeEach(() => { idCounter = 0; });

describe('computeLassoBBox', () => {
  it('computes bbox for selected strokes and overlays', () => {
    const strokes = [makeStroke('s:1', [0, 0, 10, 10]), makeStroke('s:2', [20, 20, 30, 30])];
    const overlays = [makeOverlay('o:1', 5, 5, 50, 50)];
    const bbox = computeLassoBBox(strokes, overlays, new Set(['s:1', 's:2']), new Set(['o:1']));
    expect(bbox).toEqual([0, 0, 55, 55]);
  });

  it('returns null for empty selection', () => {
    expect(computeLassoBBox([], [], new Set(), new Set())).toBeNull();
  });

  it('ignores non-selected elements', () => {
    const strokes = [makeStroke('s:1', [0, 0, 10, 10]), makeStroke('s:2', [100, 100, 200, 200])];
    const bbox = computeLassoBBox(strokes, [], new Set(['s:1']), new Set());
    expect(bbox).toEqual([0, 0, 10, 10]);
  });
});

describe('extractLassoSelectedData', () => {
  it('extracts only selected elements', () => {
    const strokes = [makeStroke('s:1', [0, 0, 10, 10]), makeStroke('s:2', [20, 20, 30, 30])];
    const overlays = [makeOverlay('o:1', 0, 0, 10, 10), makeOverlay('o:2', 50, 50, 10, 10)];
    const data = extractLassoSelectedData(strokes, overlays, new Set(['s:1']), new Set(['o:2']));
    expect(data.strokes).toHaveLength(1);
    expect(data.strokes[0].id).toBe('s:1');
    expect(data.overlays).toHaveLength(1);
    expect(data.overlays[0].overlayId).toBe('o:2');
  });
});

describe('buildLassoMoveData', () => {
  it('generates erase + draw + OT sub-events', () => {
    const original = [makeStroke('s:1', [0, 0, 10, 10])];
    const moved = [{ ...makeStroke('s:new', [5, 5, 15, 15]), path: 'M 5 5 L 15 15' }];
    const overlayDeltas = [{ overlayId: 'o:1', dx: 5, dy: 5 }];
    const { subEvents, ops } = buildLassoMoveData(original, moved, overlayDeltas, 'ts', 'sid', mockIds);
    expect(subEvents.length).toBe(3); // E, D, OT
    expect(ops.length).toBe(3);
    expect(subEvents[0].type).toBe('E');
    expect(subEvents[1].type).toBe('D');
    expect(subEvents[2].type).toBe('OT');
  });
});

describe('buildLassoDeleteData', () => {
  it('generates erase + OR sub-events', () => {
    const strokes = [makeStroke('s:1', [0, 0, 10, 10])];
    const overlayMap = new Map<string, OverlayState>([['o:1', makeOverlay('o:1', 0, 0, 10, 10)]]);
    const { subEvents, ops: _ops } = buildLassoDeleteData(strokes, ['o:1'], overlayMap, 'ts', 'sid', mockIds);
    expect(subEvents.length).toBe(2); // E, OR
    expect(subEvents[0].type).toBe('E');
    expect(subEvents[1].type).toBe('OR');
  });
});

describe('buildLassoCreateData', () => {
  it('generates new strokes and overlays with offset', () => {
    const strokes = [makeStroke('s:1', [0, 0, 10, 10])];
    const overlays = [makeOverlay('o:1', 100, 100, 50, 50)];
    const { subEvents, ops: _ops, newStrokeIds, newOverlayIds } = buildLassoCreateData(
      strokes, overlays, 20, 30, 5, 'ts', 'sid', mockIds,
    );
    expect(newStrokeIds).toHaveLength(1);
    expect(newOverlayIds).toHaveLength(1);
    expect(subEvents).toHaveLength(2); // D, OA
    // OA has offset position
    const oaEvent = subEvents[1];
    if (oaEvent.type === 'OA') {
      expect(oaEvent.x).toBe(120);
      expect(oaEvent.y).toBe(130);
      expect(oaEvent.zIndex).toBe(6); // maxZ + 1
    }
  });
});
