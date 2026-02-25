import { describe, it, expect } from 'vitest';
import {
  computeBringToFront,
  computeBringForward,
  computeSendBackward,
  computeSendToBack,
  buildStyleSubEvents,
  sortOverlaysByZIndex,
  computeBoardViewportTransform,
} from '../overlay-ops';
import type { OverlayState } from '../types';

function makeOverlay(id: string, zIndex: number): OverlayState {
  return {
    overlayId: id, assetUuid: 'a:001',
    x: 0, y: 0, width: 100, height: 100, rotation: 0,
    viewport: { x: 0, y: 0, width: 0, height: 0 },
    page: 1, zIndex, opacity: 1.0,
  };
}

describe('z-index operations', () => {
  const overlays = [makeOverlay('o:1', 1), makeOverlay('o:2', 2), makeOverlay('o:3', 3)];

  it('computeBringToFront moves to max+1', () => {
    const targets = computeBringToFront(overlays[0], overlays);
    expect(targets).not.toBeNull();
    expect(targets![0].after.zIndex).toBe(4);
  });

  it('computeBringToFront returns null if already top', () => {
    expect(computeBringToFront(overlays[2], overlays)).toBeNull();
  });

  it('computeBringForward swaps with above', () => {
    const targets = computeBringForward(overlays[0], overlays);
    expect(targets).not.toBeNull();
    expect(targets).toHaveLength(2);
    expect(targets![0].overlayId).toBe('o:1');
    expect(targets![0].after.zIndex).toBe(2);
    expect(targets![1].overlayId).toBe('o:2');
    expect(targets![1].after.zIndex).toBe(1);
  });

  it('computeBringForward returns null if already top', () => {
    expect(computeBringForward(overlays[2], overlays)).toBeNull();
  });

  it('computeSendBackward swaps with below', () => {
    const targets = computeSendBackward(overlays[2], overlays);
    expect(targets).not.toBeNull();
    expect(targets).toHaveLength(2);
    expect(targets![0].after.zIndex).toBe(2); // o:3 takes o:2's zIndex
    expect(targets![1].after.zIndex).toBe(3); // o:2 takes o:3's zIndex
  });

  it('computeSendBackward returns null if already bottom', () => {
    expect(computeSendBackward(overlays[0], overlays)).toBeNull();
  });

  it('computeSendToBack moves to min-1', () => {
    const targets = computeSendToBack(overlays[2], overlays);
    expect(targets).not.toBeNull();
    expect(targets![0].after.zIndex).toBe(0);
  });

  it('computeSendToBack returns null if already bottom', () => {
    expect(computeSendToBack(overlays[0], overlays)).toBeNull();
  });
});

describe('buildStyleSubEvents', () => {
  it('generates OS sub-events from targets', () => {
    const targets = [
      { overlayId: 'o:1', before: { zIndex: 1, opacity: 1 }, after: { zIndex: 2, opacity: 1 } },
      { overlayId: 'o:2', before: { zIndex: 2, opacity: 0.5 }, after: { zIndex: 1, opacity: 0.5 } },
    ];
    let idCounter = 0;
    const { subEvents, ops } = buildStyleSubEvents(targets, 'ts', 'sid', () => `os:${idCounter++}`);
    expect(subEvents).toHaveLength(2);
    expect(ops).toHaveLength(2);
    expect(subEvents[0].type).toBe('OS');
    expect(ops[0].type).toBe('overlayStyle');
  });
});

describe('sortOverlaysByZIndex', () => {
  it('sorts ascending', () => {
    const overlays = [makeOverlay('o:3', 3), makeOverlay('o:1', 1), makeOverlay('o:2', 2)];
    const sorted = sortOverlaysByZIndex(overlays);
    expect(sorted.map(o => o.overlayId)).toEqual(['o:1', 'o:2', 'o:3']);
  });
});

describe('computeBoardViewportTransform', () => {
  it('computes new overlay position from viewport change', () => {
    const overlay = { x: 0, y: 0, width: 100, height: 100 };
    const vpOld = { x: 0, y: 0, width: 100, height: 100 };
    const vpNew = { x: 50, y: 50, width: 100, height: 100 };
    const result = computeBoardViewportTransform(overlay, vpOld, vpNew);
    expect(result).not.toBeNull();
    expect(result!.x).toBe(50);
    expect(result!.y).toBe(50);
  });

  it('returns null for no change', () => {
    const overlay = { x: 0, y: 0, width: 100, height: 100 };
    const vp = { x: 0, y: 0, width: 100, height: 100 };
    expect(computeBoardViewportTransform(overlay, vp, vp)).toBeNull();
  });
});
