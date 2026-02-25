import { describe, it, expect } from 'vitest';
import {
  distance,
  distanceSq,
  dot,
  length,
  normalize,
  negate,
  add,
  subtract,
  scale,
  toRadians,
  toDegrees,
  angleBetween,
  removeDuplicates,
  applyMovingAverage,
  totalLength,
  chordLengthParameterize,
  calculateVelocities,
  smoothVelocities,
} from '../math';
import { toSvgPath, fitCurveToSvgPath, CurvePipeline } from '../pipeline';
import { fitBezier } from '../bezier-fitter';
import { DEFAULT_CONFIG } from '../config';
import type { InputPoint, BezierSegment } from '../curve-types';

// ========================================
// 基本的な幾何ユーティリティ
// ========================================

describe('math - basic geometry', () => {
  it('distance computes correctly', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBeCloseTo(5);
    expect(distance({ x: 1, y: 1 }, { x: 1, y: 1 })).toBe(0);
  });

  it('distanceSq computes correctly', () => {
    expect(distanceSq({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(25);
  });

  it('dot product', () => {
    expect(dot({ x: 1, y: 0 }, { x: 0, y: 1 })).toBe(0);
    expect(dot({ x: 2, y: 3 }, { x: 4, y: 5 })).toBe(23);
  });

  it('length', () => {
    expect(length({ x: 3, y: 4 })).toBeCloseTo(5);
    expect(length({ x: 0, y: 0 })).toBe(0);
  });

  it('normalize', () => {
    const n = normalize({ x: 3, y: 4 });
    expect(length(n)).toBeCloseTo(1, 10);
    expect(n.x).toBeCloseTo(0.6);
    expect(n.y).toBeCloseTo(0.8);
  });

  it('normalize zero vector returns default unit vector', () => {
    const n = normalize({ x: 0, y: 0 });
    // Implementation returns (1, 0) for zero-length vectors
    expect(n.x).toBe(1);
    expect(n.y).toBe(0);
  });

  it('negate', () => {
    const r = negate({ x: 3, y: -2 });
    expect(r).toEqual({ x: -3, y: 2 });
  });

  it('add', () => {
    expect(add({ x: 1, y: 2 }, { x: 3, y: 4 })).toEqual({ x: 4, y: 6 });
  });

  it('subtract', () => {
    expect(subtract({ x: 5, y: 3 }, { x: 2, y: 1 })).toEqual({ x: 3, y: 2 });
  });

  it('scale', () => {
    expect(scale({ x: 2, y: 3 }, 4)).toEqual({ x: 8, y: 12 });
  });
});

// ========================================
// 角度変換
// ========================================

describe('math - angle conversions', () => {
  it('toRadians', () => {
    expect(toRadians(180)).toBeCloseTo(Math.PI);
    expect(toRadians(90)).toBeCloseTo(Math.PI / 2);
    expect(toRadians(0)).toBe(0);
  });

  it('toDegrees', () => {
    expect(toDegrees(Math.PI)).toBeCloseTo(180);
    expect(toDegrees(Math.PI / 2)).toBeCloseTo(90);
  });

  it('angleBetween three collinear points returns π', () => {
    const angle = angleBetween({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 });
    expect(angle).toBeCloseTo(Math.PI);
  });

  it('angleBetween right angle returns π/2', () => {
    const angle = angleBetween({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 });
    expect(angle).toBeCloseTo(Math.PI / 2);
  });
});

// ========================================
// 点列前処理
// ========================================

describe('math - point preprocessing', () => {
  it('removeDuplicates removes points within threshold', () => {
    const pts: InputPoint[] = [
      { x: 0, y: 0 },
      { x: 0.5, y: 0 },  // within threshold of 1
      { x: 5, y: 0 },
      { x: 5.3, y: 0 },  // within threshold of 1
      { x: 10, y: 0 },
    ];
    const result = removeDuplicates(pts, 1);
    expect(result.length).toBe(3);
    expect(result[0].x).toBe(0);
    expect(result[1].x).toBe(5);
    expect(result[2].x).toBe(10);
  });

  it('removeDuplicates preserves single point', () => {
    const pts: InputPoint[] = [{ x: 0, y: 0 }];
    expect(removeDuplicates(pts, 1)).toHaveLength(1);
  });

  it('applyMovingAverage smooths points', () => {
    const pts: InputPoint[] = [
      { x: 0, y: 0, timestamp: 0 },
      { x: 10, y: 0, timestamp: 10 },
      { x: 20, y: 0, timestamp: 20 },
      { x: 30, y: 0, timestamp: 30 },
      { x: 40, y: 0, timestamp: 40 },
    ];
    const result = applyMovingAverage(pts, 3);
    expect(result).toHaveLength(5);
    // Endpoints should be preserved
    expect(result[0].x).toBe(0);
    expect(result[4].x).toBe(40);
  });

  it('totalLength computes path length', () => {
    const pts: InputPoint[] = [
      { x: 0, y: 0 },
      { x: 3, y: 4 },
      { x: 6, y: 0 },
    ];
    const len = totalLength(pts);
    expect(len).toBeCloseTo(10); // 5 + 5
  });

  it('chordLengthParameterize returns [0, ..., 1]', () => {
    const pts: InputPoint[] = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
    ];
    const params = chordLengthParameterize(pts);
    expect(params).toHaveLength(3);
    expect(params[0]).toBe(0);
    expect(params[2]).toBe(1);
    expect(params[1]).toBeCloseTo(0.5);
  });
});

// ========================================
// 速度計算
// ========================================

describe('math - velocity', () => {
  it('calculateVelocities returns one velocity per point', () => {
    const pts: InputPoint[] = [
      { x: 0, y: 0, timestamp: 0 },
      { x: 10, y: 0, timestamp: 100 },
      { x: 20, y: 0, timestamp: 200 },
    ];
    const vels = calculateVelocities(pts);
    expect(vels).toHaveLength(3);
    // All velocities should be approximately equal (100px/s = 0.1px/ms)
    expect(vels[1]).toBeCloseTo(0.1, 1);
  });

  it('smoothVelocities reduces noise', () => {
    const vels = [0.1, 10.0, 0.1, 0.1, 0.1];
    const smoothed = smoothVelocities(vels, 3);
    expect(smoothed).toHaveLength(5);
    // The spike at index 1 should be reduced
    expect(smoothed[1]).toBeLessThan(10.0);
  });
});

// ========================================
// ベジェフィッティング
// ========================================

describe('fitBezier', () => {
  const defaultFitConfig = { tolerance: 4.0, maxIterations: 4 };

  it('fits a straight line to a single segment', () => {
    const pts: InputPoint[] = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 100, y: 0 },
    ];
    const segments = fitBezier(pts, defaultFitConfig);
    expect(segments.length).toBeGreaterThanOrEqual(1);
    // Start and end should match input
    expect(segments[0].p0.x).toBeCloseTo(0);
    expect(segments[segments.length - 1].p3.x).toBeCloseTo(100);
  });

  it('returns degenerate segment for single point', () => {
    const segments = fitBezier([{ x: 0, y: 0 }], defaultFitConfig);
    // Single point produces a degenerate bezier segment
    expect(segments).toHaveLength(1);
    expect(segments[0].p0).toEqual({ x: 0, y: 0 });
    expect(segments[0].p3).toEqual({ x: 0, y: 0 });
  });

  it('fits a curve with reasonable accuracy', () => {
    // Quarter circle
    const pts: InputPoint[] = [];
    for (let i = 0; i <= 20; i++) {
      const t = (i / 20) * Math.PI / 2;
      pts.push({ x: Math.cos(t) * 100, y: Math.sin(t) * 100 });
    }
    const segments = fitBezier(pts, defaultFitConfig);
    expect(segments.length).toBeGreaterThanOrEqual(1);
    // Endpoint should be near (0, 100)
    const last = segments[segments.length - 1].p3;
    expect(last.x).toBeCloseTo(0, 0);
    expect(last.y).toBeCloseTo(100, 0);
  });
});

// ========================================
// toSvgPath
// ========================================

describe('toSvgPath', () => {
  it('converts segments to SVG path', () => {
    const segments: BezierSegment[] = [
      {
        p0: { x: 0, y: 0 },
        p1: { x: 10, y: 20 },
        p2: { x: 30, y: 40 },
        p3: { x: 50, y: 50 },
      },
    ];
    const path = toSvgPath(segments);
    expect(path).toContain('M');
    expect(path).toContain('C');
  });

  it('returns empty string for no segments', () => {
    expect(toSvgPath([])).toBe('');
  });
});

// ========================================
// fitCurveToSvgPath (end-to-end)
// ========================================

describe('fitCurveToSvgPath', () => {
  it('produces valid SVG path from input points', () => {
    const pts: InputPoint[] = [];
    for (let i = 0; i <= 30; i++) {
      pts.push({ x: i * 10, y: Math.sin(i / 5) * 50, timestamp: i * 10 });
    }
    const path = fitCurveToSvgPath(pts);
    expect(path).toContain('M');
    expect(path).toContain('C');
    expect(path.length).toBeGreaterThan(10);
  });

  it('returns degenerate path for a single point', () => {
    const path = fitCurveToSvgPath([{ x: 0, y: 0 }]);
    // Pipeline produces a degenerate bezier for single point
    expect(path).toContain('M');
  });
});

// ========================================
// CurvePipeline
// ========================================

describe('CurvePipeline', () => {
  it('default pipeline processes without error', () => {
    const pipeline = CurvePipeline.default();
    const pts: InputPoint[] = [];
    for (let i = 0; i <= 20; i++) {
      pts.push({ x: i * 10, y: i * 5, timestamp: i * 10, pressure: 0.5 });
    }
    const result = pipeline.run(pts, DEFAULT_CONFIG);
    expect(result.bezierSegments.length).toBeGreaterThan(0);
    const svg = toSvgPath(result.bezierSegments);
    expect(svg).toContain('M');
  });

  it('pipeline has expected stage names', () => {
    const pipeline = CurvePipeline.default();
    const names = pipeline.getStageNames();
    expect(names).toContain('preprocess');
    expect(names).toContain('corner-detect');
    expect(names).toContain('segment-split');
    expect(names).toContain('bezier-fit');
  });

  it('stages can be listed', () => {
    const pipeline = CurvePipeline.default();
    expect(pipeline.getStageNames().length).toBeGreaterThanOrEqual(4);
  });
});
