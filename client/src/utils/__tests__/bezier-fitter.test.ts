/**
 * utils/__tests__/bezier-fitter.test.ts
 *
 * Schneider 法ベジェフィッティングのテスト。
 * 基本図形（直線・曲線）でフィッティング精度を検証。
 */

import { describe, it, expect } from 'vitest';
import { fitBezier } from '../bezier-fitter';
import type { InputPoint, FittingConfig, BezierSegment } from '../curve-types';

// ========================================
// テスト用設定
// ========================================

const defaultFittingConfig: FittingConfig = {
  tolerance: 2.0,
  maxIterations: 4,
};

// ========================================
// ヘルパー
// ========================================

/** ベジェ曲線上の点を t パラメータで評価 */
function evalBezier(seg: BezierSegment, t: number): { x: number; y: number } {
  const u = 1 - t;
  return {
    x: u * u * u * seg.p0.x + 3 * u * u * t * seg.p1.x + 3 * u * t * t * seg.p2.x + t * t * t * seg.p3.x,
    y: u * u * u * seg.p0.y + 3 * u * u * t * seg.p1.y + 3 * u * t * t * seg.p2.y + t * t * t * seg.p3.y,
  };
}

/** 元の点列からフィット結果までの最大距離 */
function maxFitError(points: InputPoint[], segments: BezierSegment[]): number {
  if (segments.length === 0) return 0;
  let maxError = 0;

  for (const pt of points) {
    let minDist = Infinity;
    for (const seg of segments) {
      // 粗くサンプリングして最小距離を求める
      for (let t = 0; t <= 1; t += 0.02) {
        const bp = evalBezier(seg, t);
        const dx = bp.x - pt.x;
        const dy = bp.y - pt.y;
        minDist = Math.min(minDist, Math.sqrt(dx * dx + dy * dy));
      }
    }
    maxError = Math.max(maxError, minDist);
  }
  return maxError;
}

/** 直線の点列を生成 */
function makeLine(x0: number, y0: number, x1: number, y1: number, n: number): InputPoint[] {
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    return { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t };
  });
}

/** 円弧の点列を生成 */
function makeArc(cx: number, cy: number, r: number, start: number, end: number, n: number): InputPoint[] {
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    const a = start + (end - start) * t;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  });
}

// ========================================
// テスト
// ========================================

describe('fitBezier — edge cases', () => {
  it('returns empty for empty input', () => {
    expect(fitBezier([], defaultFittingConfig)).toEqual([]);
  });

  it('returns degenerate segment for single point', () => {
    const segments = fitBezier([{ x: 42, y: 7 }], defaultFittingConfig);
    expect(segments).toHaveLength(1);
    const s = segments[0];
    expect(s.p0.x).toBe(42);
    expect(s.p3.x).toBe(42);
  });

  it('returns a linear segment for 2 points', () => {
    const segments = fitBezier(
      [{ x: 0, y: 0 }, { x: 100, y: 0 }],
      defaultFittingConfig,
    );
    expect(segments).toHaveLength(1);
    expect(segments[0].p0.x).toBeCloseTo(0);
    expect(segments[0].p3.x).toBeCloseTo(100);
  });
});

describe('fitBezier — straight line', () => {
  it('fits a horizontal line with low error', () => {
    const points = makeLine(0, 0, 200, 0, 20);
    const segments = fitBezier(points, defaultFittingConfig);
    expect(segments.length).toBeGreaterThanOrEqual(1);

    const error = maxFitError(points, segments);
    // Schneider法は二乗誤差ベースなので tolerance の2〜3倍程度まで許容
    expect(error).toBeLessThan(defaultFittingConfig.tolerance * 3);
  });

  it('fits a diagonal line with low error', () => {
    const points = makeLine(0, 0, 100, 100, 15);
    const segments = fitBezier(points, defaultFittingConfig);
    expect(segments.length).toBeGreaterThanOrEqual(1);

    const error = maxFitError(points, segments);
    expect(error).toBeLessThan(defaultFittingConfig.tolerance * 3);
  });
});

describe('fitBezier — curves', () => {
  it('fits a quarter circle arc within tolerance', () => {
    const points = makeArc(0, 0, 100, 0, Math.PI / 2, 30);
    const segments = fitBezier(points, defaultFittingConfig);
    expect(segments.length).toBeGreaterThanOrEqual(1);

    const error = maxFitError(points, segments);
    expect(error).toBeLessThan(defaultFittingConfig.tolerance * 2);
  });

  it('fits a semicircle arc', () => {
    const points = makeArc(0, 0, 80, 0, Math.PI, 40);
    const segments = fitBezier(points, { tolerance: 3, maxIterations: 4 });
    expect(segments.length).toBeGreaterThanOrEqual(1);

    const error = maxFitError(points, segments);
    // 半円はベジェ曲線で完全には表現できないため、少し広い許容範囲
    expect(error).toBeLessThan(8);
  });

  it('fits an S-curve', () => {
    // S字カーブ: 上半分は右向き、下半分は左向きの円弧
    const upper = makeArc(0, 0, 50, -Math.PI / 2, Math.PI / 2, 20);
    const lower = makeArc(0, 100, 50, Math.PI / 2, -Math.PI / 2, 20);
    // 接続点の重複を除去
    const points = [...upper, ...lower.slice(1)];

    const segments = fitBezier(points, { tolerance: 3, maxIterations: 4 });
    expect(segments.length).toBeGreaterThanOrEqual(1);
  });
});

describe('fitBezier — segment continuity', () => {
  it('consecutive segments share endpoints', () => {
    const points = makeArc(0, 0, 100, 0, Math.PI, 50);
    const segments = fitBezier(points, defaultFittingConfig);

    for (let i = 1; i < segments.length; i++) {
      const prevEnd = segments[i - 1].p3;
      const nextStart = segments[i].p0;
      expect(prevEnd.x).toBeCloseTo(nextStart.x, 1);
      expect(prevEnd.y).toBeCloseTo(nextStart.y, 1);
    }
  });

  it('first segment starts near first point', () => {
    const points = makeLine(10, 20, 200, 300, 25);
    const segments = fitBezier(points, defaultFittingConfig);
    expect(segments[0].p0.x).toBeCloseTo(10, 0);
    expect(segments[0].p0.y).toBeCloseTo(20, 0);
  });

  it('last segment ends near last point', () => {
    const points = makeLine(10, 20, 200, 300, 25);
    const segments = fitBezier(points, defaultFittingConfig);
    const last = segments[segments.length - 1];
    expect(last.p3.x).toBeCloseTo(200, 0);
    expect(last.p3.y).toBeCloseTo(300, 0);
  });
});

describe('fitBezier — tolerance sensitivity', () => {
  it('tighter tolerance may produce more segments', () => {
    const points = makeArc(0, 0, 100, 0, Math.PI, 40);

    const looseSegs = fitBezier(points, { tolerance: 10, maxIterations: 4 });
    const tightSegs = fitBezier(points, { tolerance: 1, maxIterations: 4 });

    // tighter tolerance → 同じかそれ以上のセグメント数
    expect(tightSegs.length).toBeGreaterThanOrEqual(looseSegs.length);
  });
});
