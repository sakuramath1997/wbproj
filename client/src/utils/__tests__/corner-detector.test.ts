/**
 * utils/__tests__/corner-detector.test.ts
 *
 * コーナー検出アルゴリズムのテスト。
 * 合成入力データ（L字、直線、四角形等）で検証。
 */

import { describe, it, expect } from 'vitest';
import { detectCorners, splitAtCorners } from '../corner-detector';
import type { InputPoint, CornerDetectionConfig } from '../curve-types';

// ========================================
// テスト用デフォルト設定
// ========================================

const defaultConfig: CornerDetectionConfig = {
  angleThreshold: 30,
  windowSize: 3,
  velocityThreshold: 0.3,
  useVelocity: false,
  usePressure: false,
  pressureThreshold: 0.3,
  minCornerDistance: 5,
  useCurvature: false,
  curvatureThreshold: 0.5,
};

// ========================================
// ヘルパー: 合成入力データ生成
// ========================================

/** 直線上の点列を生成 */
function makeLine(
  x0: number, y0: number,
  x1: number, y1: number,
  n: number,
): InputPoint[] {
  const points: InputPoint[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    points.push({ x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t });
  }
  return points;
}

/** L字型の点列: (0,0)→(100,0)→(100,100) */
function makeLShape(segmentPoints: number): InputPoint[] {
  const right = makeLine(0, 0, 100, 0, segmentPoints);
  const down = makeLine(100, 0, 100, 100, segmentPoints);
  // 重複する接続点を除去
  return [...right, ...down.slice(1)];
}

/** コの字型: (0,0)→(100,0)→(100,100)→(0,100) */
function makeUShape(segmentPoints: number): InputPoint[] {
  const seg1 = makeLine(0, 0, 100, 0, segmentPoints);
  const seg2 = makeLine(100, 0, 100, 100, segmentPoints);
  const seg3 = makeLine(100, 100, 0, 100, segmentPoints);
  return [...seg1, ...seg2.slice(1), ...seg3.slice(1)];
}

/** 円弧（滑らかなカーブ、コーナーなし） */
function makeArc(
  cx: number, cy: number, r: number,
  startAngle: number, endAngle: number,
  n: number,
): InputPoint[] {
  const points: InputPoint[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const angle = startAngle + (endAngle - startAngle) * t;
    points.push({
      x: cx + r * Math.cos(angle),
      y: cy + r * Math.sin(angle),
    });
  }
  return points;
}

// ========================================
// テスト
// ========================================

describe('detectCorners', () => {
  it('returns empty for fewer than 3 points', () => {
    expect(detectCorners([], defaultConfig)).toEqual([]);
    expect(detectCorners([{ x: 0, y: 0 }], defaultConfig)).toEqual([]);
    expect(detectCorners([{ x: 0, y: 0 }, { x: 1, y: 1 }], defaultConfig)).toEqual([]);
  });

  it('finds no corners on a straight line', () => {
    const line = makeLine(0, 0, 100, 0, 30);
    const corners = detectCorners(line, defaultConfig);
    expect(corners).toHaveLength(0);
  });

  it('detects a corner on an L-shape', () => {
    const lShape = makeLShape(20);
    const corners = detectCorners(lShape, defaultConfig);
    // L字の角に 1 つのコーナーを検出
    expect(corners.length).toBeGreaterThanOrEqual(1);
    // コーナーは中間点（接続点付近）にある
    const cornerIndices = corners.map(c => c.index);
    // 接続点は index 19 付近
    const nearMiddle = cornerIndices.some(idx => Math.abs(idx - 19) <= 5);
    expect(nearMiddle).toBe(true);
  });

  it('detects 2 corners on a U-shape', () => {
    const uShape = makeUShape(25);
    const corners = detectCorners(uShape, {
      ...defaultConfig,
      minCornerDistance: 8,
    });
    expect(corners.length).toBeGreaterThanOrEqual(2);
  });

  it('finds no corners on a smooth arc', () => {
    const arc = makeArc(0, 0, 100, 0, Math.PI, 50);
    const corners = detectCorners(arc, defaultConfig);
    // 滑らかなカーブではコーナーを検出しない
    expect(corners).toHaveLength(0);
  });

  it('returns corners with valid confidence [0, 1]', () => {
    const lShape = makeLShape(20);
    const corners = detectCorners(lShape, defaultConfig);
    for (const c of corners) {
      expect(c.confidence).toBeGreaterThanOrEqual(0);
      expect(c.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('returns corners sorted by index', () => {
    const uShape = makeUShape(25);
    const corners = detectCorners(uShape, defaultConfig);
    for (let i = 1; i < corners.length; i++) {
      expect(corners[i].index).toBeGreaterThan(corners[i - 1].index);
    }
  });
});

describe('detectCorners with curvature', () => {
  it('finds corners when curvature detection is enabled', () => {
    const lShape = makeLShape(30);
    const config: CornerDetectionConfig = {
      ...defaultConfig,
      useCurvature: true,
      curvatureThreshold: 0.5,
    };
    const corners = detectCorners(lShape, config);
    expect(corners.length).toBeGreaterThanOrEqual(1);
  });
});

describe('detectCorners with velocity', () => {
  it('returns no velocity corners when timestamps are absent', () => {
    const lShape = makeLShape(20);
    const config: CornerDetectionConfig = {
      ...defaultConfig,
      useVelocity: true,
    };
    // velocity detection skips when no timestamps — only angle-based corners
    const corners = detectCorners(lShape, config);
    for (const c of corners) {
      expect(c.source).not.toBe('velocity');
    }
  });

  it('detects velocity corners with timestamps', () => {
    // L字を描くとき、角で速度が落ちるシミュレーション
    const points: InputPoint[] = [];
    // 水平セグメント: 速い
    for (let i = 0; i < 20; i++) {
      points.push({ x: i * 5, y: 0, timestamp: i * 10 });
    }
    // 角付近: 遅い
    for (let i = 0; i < 5; i++) {
      points.push({ x: 100, y: i * 2, timestamp: 200 + i * 50 });
    }
    // 垂直セグメント: 速い
    for (let i = 0; i < 20; i++) {
      points.push({ x: 100, y: 10 + i * 5, timestamp: 450 + i * 10 });
    }

    const config: CornerDetectionConfig = {
      ...defaultConfig,
      useVelocity: true,
      windowSize: 2,
      minCornerDistance: 3,
    };
    const corners = detectCorners(points, config);
    expect(corners.length).toBeGreaterThanOrEqual(1);
  });
});

// ========================================
// splitAtCorners
// ========================================

describe('splitAtCorners', () => {
  it('returns the entire array as one segment when no corners', () => {
    const points: InputPoint[] = [
      { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 },
    ];
    const segments = splitAtCorners(points, []);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toEqual(points);
  });

  it('splits at a single corner', () => {
    const points: InputPoint[] = Array.from({ length: 10 }, (_, i) => ({
      x: i * 10, y: 0,
    }));

    const corners = [{
      index: 5,
      point: points[5],
      angle: Math.PI / 2,
      confidence: 0.8,
      source: 'angle' as const,
    }];

    const segments = splitAtCorners(points, corners);
    expect(segments).toHaveLength(2);
    // 最初のセグメント: [0, 5] (コーナー含む)
    expect(segments[0]).toHaveLength(6);
    // 2番目のセグメント: [5, 9] (コーナーが始点)
    expect(segments[1]).toHaveLength(5);
    // コーナー点が両セグメントに共有される
    expect(segments[0][segments[0].length - 1]).toBe(points[5]);
    expect(segments[1][0]).toBe(points[5]);
  });

  it('splits at multiple corners', () => {
    const points: InputPoint[] = Array.from({ length: 20 }, (_, i) => ({
      x: i * 5, y: 0,
    }));

    const corners = [
      { index: 5, point: points[5], angle: 1, confidence: 0.8, source: 'angle' as const },
      { index: 12, point: points[12], angle: 1, confidence: 0.7, source: 'angle' as const },
    ];

    const segments = splitAtCorners(points, corners);
    expect(segments).toHaveLength(3);
  });
});
