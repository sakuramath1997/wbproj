/**
 * utils/__tests__/common.test.ts
 *
 * ID 生成・BBox 計算・セッション ID バリデーション のテスト。
 */

import { describe, it, expect } from 'vitest';
import {
  generateStrokeId,
  generateEraseId,
  generateOverlayId,
  generateRemoveId,
  generateTransformOpId,
  generateViewportOpId,
  generateStyleOpId,
  generateBgOpId,
  generateCsOpId,
  generateBatchId,
  generateUuid,
  generateSnapshotHash,
  getTimestamp,
  isValidSessionId,
  calculateBBox,
  isPointInBBox,
  getNextBoardId,
} from '../common';

// ========================================
// ID 生成
// ========================================

describe('ID generation', () => {
  const generators: Array<[string, () => string, string]> = [
    ['generateStrokeId', generateStrokeId, 's:'],
    ['generateEraseId', generateEraseId, 'e:'],
    ['generateOverlayId', generateOverlayId, 'o:'],
    ['generateRemoveId', generateRemoveId, 'r:'],
    ['generateTransformOpId', generateTransformOpId, 'ot:'],
    ['generateViewportOpId', generateViewportOpId, 'ov:'],
    ['generateStyleOpId', generateStyleOpId, 'os:'],
    ['generateBgOpId', generateBgOpId, 'bg:'],
    ['generateCsOpId', generateCsOpId, 'cs:'],
    ['generateBatchId', generateBatchId, 'b:'],
  ];

  for (const [name, fn, prefix] of generators) {
    it(`${name} returns ID with prefix "${prefix}"`, () => {
      const id = fn();
      expect(id.startsWith(prefix)).toBe(true);
    });

    it(`${name} returns ID with 12-char random suffix`, () => {
      const id = fn();
      const suffix = id.slice(id.indexOf(':') + 1);
      expect(suffix).toHaveLength(12);
      expect(suffix).toMatch(/^[a-z0-9]+$/);
    });

    it(`${name} generates unique IDs`, () => {
      const ids = new Set(Array.from({ length: 100 }, () => fn()));
      expect(ids.size).toBe(100);
    });
  }
});

describe('generateUuid', () => {
  it('returns valid UUID v4 format', () => {
    const uuid = generateUuid();
    expect(uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it('generates unique UUIDs', () => {
    const uuids = new Set(Array.from({ length: 50 }, () => generateUuid()));
    expect(uuids.size).toBe(50);
  });
});

describe('generateSnapshotHash', () => {
  it('starts with "sha256:" prefix', () => {
    expect(generateSnapshotHash().startsWith('sha256:')).toBe(true);
  });

  it('is non-empty after prefix', () => {
    const hash = generateSnapshotHash();
    expect(hash.length).toBeGreaterThan('sha256:'.length);
  });
});

// ========================================
// タイムスタンプ
// ========================================

describe('getTimestamp', () => {
  it('returns ISO 8601 string', () => {
    const ts = getTimestamp();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('is parseable as a Date', () => {
    const ts = getTimestamp();
    const d = new Date(ts);
    expect(d.getTime()).not.toBeNaN();
  });
});

// ========================================
// セッション ID バリデーション
// ========================================

describe('isValidSessionId', () => {
  it('accepts empty string', () => {
    expect(isValidSessionId('')).toBe(true);
  });

  it('accepts alphanumeric with underscore/hyphen', () => {
    expect(isValidSessionId('user_123-abc')).toBe(true);
  });

  it('rejects strings longer than 32 chars', () => {
    expect(isValidSessionId('a'.repeat(33))).toBe(false);
  });

  it('accepts strings of exactly 32 chars', () => {
    expect(isValidSessionId('a'.repeat(32))).toBe(true);
  });

  it('rejects strings with spaces', () => {
    expect(isValidSessionId('user 123')).toBe(false);
  });

  it('rejects strings with special characters', () => {
    expect(isValidSessionId('user@123')).toBe(false);
    expect(isValidSessionId('user.123')).toBe(false);
  });
});

// ========================================
// BBox 計算
// ========================================

describe('calculateBBox', () => {
  it('returns [0,0,0,0] for empty array', () => {
    expect(calculateBBox([])).toEqual([0, 0, 0, 0]);
  });

  it('computes correct bbox for single point', () => {
    const bbox = calculateBBox([{ x: 10, y: 20 }]);
    expect(bbox).toEqual([10, 20, 10, 20]);
  });

  it('computes correct bbox for multiple points', () => {
    const bbox = calculateBBox([
      { x: 5, y: 10 },
      { x: 15, y: 3 },
      { x: 8, y: 25 },
    ]);
    expect(bbox).toEqual([5, 3, 15, 25]);
  });

  it('floors min and ceils max for fractional coords', () => {
    const bbox = calculateBBox([
      { x: 0.7, y: 1.3 },
      { x: 9.2, y: 8.8 },
    ]);
    expect(bbox).toEqual([0, 1, 10, 9]);
  });
});

describe('isPointInBBox', () => {
  const bbox: [number, number, number, number] = [10, 20, 100, 80];

  it('returns true for point inside', () => {
    expect(isPointInBBox(50, 50, bbox)).toBe(true);
  });

  it('returns true for point on edge', () => {
    expect(isPointInBBox(10, 20, bbox)).toBe(true);
    expect(isPointInBBox(100, 80, bbox)).toBe(true);
  });

  it('returns false for point outside', () => {
    expect(isPointInBBox(5, 50, bbox)).toBe(false);
    expect(isPointInBBox(50, 90, bbox)).toBe(false);
  });

  it('respects margin', () => {
    expect(isPointInBBox(5, 50, bbox, 10)).toBe(true);
    expect(isPointInBBox(50, 90, bbox, 15)).toBe(true);
  });
});

// ========================================
// ボード ID
// ========================================

describe('getNextBoardId', () => {
  it('returns "0001" for empty list', () => {
    expect(getNextBoardId([])).toBe('0001');
  });

  it('returns next sequential ID', () => {
    expect(getNextBoardId(['0001', '0002'])).toBe('0003');
  });

  it('handles non-sequential IDs', () => {
    expect(getNextBoardId(['0001', '0005'])).toBe('0006');
  });

  it('zero-pads to 4 digits', () => {
    expect(getNextBoardId(['0001'])).toBe('0002');
  });
});
