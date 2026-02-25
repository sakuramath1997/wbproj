import { describe, it, expect } from 'vitest';
import {
  offsetSvgPath,
  offsetBbox,
  createUndoSubEvent,
  createRedoSubEvent,
  wrapAsBatchOrSingle,
} from '../event-builders';
import type { SingleOperation, DrawEvent } from '../types';

// ========================================
// テストヘルパー
// ========================================

const mockIdGenerators = {
  generateEraseId: () => 'e:test',
  generateRemoveId: () => 'rm:test',
  generateTransformOpId: () => 'ot:test',
  generateViewportOpId: () => 'ov:test',
  generateStyleOpId: () => 'os:test',
  generateBgOpId: () => 'bg:test',
  generateCsOpId: () => 'cs:test',
};

const ts = '2026-01-01T00:00:00.000Z';
const sid = 'session-test';

// ========================================
// offsetSvgPath
// ========================================

describe('offsetSvgPath', () => {
  it('offsets M/L path coordinates', () => {
    const result = offsetSvgPath('M 10 20 L 30 40', 5, -3);
    expect(result).toBe('M 15 17 L 35 37');
  });

  it('returns original path for zero offset', () => {
    const path = 'M 10 20 L 30 40';
    expect(offsetSvgPath(path, 0, 0)).toBe(path);
  });

  it('handles negative coordinates', () => {
    const result = offsetSvgPath('M -10 -20 L 0 0', 15, 25);
    expect(result).toBe('M 5 5 L 15 25');
  });

  it('handles decimal values', () => {
    const result = offsetSvgPath('M 10.5 20.3', 1, 1);
    expect(result).toBe('M 11.5 21.3');
  });
});

describe('offsetBbox', () => {
  it('offsets all corners', () => {
    expect(offsetBbox([10, 20, 30, 40], 5, -5)).toEqual([15, 15, 35, 35]);
  });
});

// ========================================
// createUndoSubEvent
// ========================================

describe('createUndoSubEvent', () => {
  it('undoes draw → erase', () => {
    const op: SingleOperation = {
      type: 'draw',
      strokeId: 's:001',
      strokeData: { type: 'D', timestamp: '', sessionId: '', id: 's:001', color: '#000', width: 2, bbox: [0, 0, 10, 10], path: 'M 0 0' },
    };
    const result = createUndoSubEvent(op, ts, sid, mockIdGenerators);
    expect(result.type).toBe('E');
    if (result.type === 'E') {
      expect(result.targetId).toBe('s:001');
    }
  });

  it('undoes erase → restore stroke', () => {
    const stroke: DrawEvent = { type: 'D', timestamp: 'old', sessionId: 'old', id: 's:002', color: '#f00', width: 3, bbox: [0, 0, 5, 5], path: 'M 1 1' };
    const op: SingleOperation = { type: 'erase', eraseId: 'e:001', targetId: 's:002', targetStroke: stroke };
    const result = createUndoSubEvent(op, ts, sid, mockIdGenerators);
    expect(result.type).toBe('D');
    if (result.type === 'D') {
      expect(result.id).toBe('s:002');
      expect(result.timestamp).toBe(ts);
      expect(result.sessionId).toBe(sid);
    }
  });

  it('undoes overlayTransform → negate deltas', () => {
    const op: SingleOperation = {
      type: 'overlayTransform', id: 'ot:001', overlayId: 'o:001',
      dx: 10, dy: -5, dWidth: 20, dHeight: 15, dRotation: 0,
    };
    const result = createUndoSubEvent(op, ts, sid, mockIdGenerators);
    expect(result.type).toBe('OT');
    if (result.type === 'OT') {
      expect(result.dx).toBe(-10);
      expect(result.dy).toBe(5);
      expect(result.dWidth).toBe(-20);
      expect(result.dHeight).toBe(-15);
      expect(result.dRotation).toBeUndefined(); // 0 → omitted
    }
  });

  it('undoes background → negate color delta, swap pattern enum', () => {
    const op: SingleOperation = {
      type: 'background', id: 'bg:001',
      dColor: { space: 'srgb', dr: 10, dg: -5, db: 0 },
      pattern: { prev: 'none', next: 'grid' },
      dPatternSize: 5,
    };
    const result = createUndoSubEvent(op, ts, sid, mockIdGenerators);
    expect(result.type).toBe('BG');
    if (result.type === 'BG') {
      expect(result.dColor).toEqual({ space: 'srgb', dr: -10, dg: 5, db: 0 });
      expect(result.pattern).toEqual({ prev: 'grid', next: 'none' });
      expect(result.dPatternSize).toBe(-5);
    }
  });

  it('undoes overlayStyle → negate dzIndex and dOpacity', () => {
    const op: SingleOperation = {
      type: 'overlayStyle', id: 'os:001', overlayId: 'o:001',
      dzIndex: 3, dOpacity: -0.5,
    };
    const result = createUndoSubEvent(op, ts, sid, mockIdGenerators);
    expect(result.type).toBe('OS');
    if (result.type === 'OS') {
      expect(result.dzIndex).toBe(-3);
      expect(result.dOpacity).toBe(0.5);
    }
  });
});

// ========================================
// createRedoSubEvent
// ========================================

describe('createRedoSubEvent', () => {
  it('redoes draw → re-draw', () => {
    const stroke: DrawEvent = { type: 'D', timestamp: 'old', sessionId: 'old', id: 's:001', color: '#000', width: 2, bbox: [0, 0, 10, 10], path: 'M 0 0' };
    const op: SingleOperation = { type: 'draw', strokeId: 's:001', strokeData: stroke };
    const result = createRedoSubEvent(op, ts, sid, mockIdGenerators);
    expect(result.type).toBe('D');
    if (result.type === 'D') {
      expect(result.timestamp).toBe(ts);
      expect(result.sessionId).toBe(sid);
    }
  });

  it('redoes overlayTransform → same deltas', () => {
    const op: SingleOperation = {
      type: 'overlayTransform', id: 'ot:001', overlayId: 'o:001',
      dx: 10, dy: -5, dWidth: 0, dHeight: 0, dRotation: 0,
    };
    const result = createRedoSubEvent(op, ts, sid, mockIdGenerators);
    expect(result.type).toBe('OT');
    if (result.type === 'OT') {
      expect(result.dx).toBe(10);
      expect(result.dy).toBe(-5);
    }
  });
});

// ========================================
// wrapAsBatchOrSingle
// ========================================

describe('wrapAsBatchOrSingle', () => {
  it('returns null for empty events', () => {
    expect(wrapAsBatchOrSingle([], 'b:001', ts, sid)).toBeNull();
  });

  it('returns single event unwrapped', () => {
    const event = { type: 'D' as const, timestamp: ts, sessionId: sid, id: 's:001', color: '#000', width: 2, bbox: [0, 0, 10, 10] as [number, number, number, number], path: 'M 0 0' };
    const result = wrapAsBatchOrSingle([event], 'b:001', ts, sid);
    expect(result).toBe(event);
  });

  it('wraps 2+ events in BATCH', () => {
    const events = [
      { type: 'D' as const, timestamp: ts, sessionId: sid, id: 's:001', color: '#000', width: 2, bbox: [0, 0, 10, 10] as [number, number, number, number], path: 'M 0 0' },
      { type: 'E' as const, timestamp: ts, sessionId: sid, id: 'e:001', targetId: 's:002' },
    ];
    const result = wrapAsBatchOrSingle(events, 'b:001', ts, sid);
    expect(result).not.toBeNull();
    if (result && 'type' in result && result.type === 'BATCH') {
      expect(result.id).toBe('b:001');
      expect(result.events).toHaveLength(2);
    } else {
      throw new Error('Expected BATCH');
    }
  });
});