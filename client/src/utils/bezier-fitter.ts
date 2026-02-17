/**
 * 曲線フィッティング - Schneider法によるベジェフィッティング
 * 
 * Based on "An Algorithm for Automatically Fitting Digitized Curves"
 * by Philip J. Schneider, Graphics Gems (1990)
 */

import type { InputPoint, Point, BezierSegment, FittingConfig } from './curve-types';
import { 
  distance, 
  dot, 
  normalize, 
  negate, 
  chordLengthParameterize 
} from './math';

/**
 * 点列に対してベジェ曲線をフィット
 */
export function fitBezier(
  points: InputPoint[],
  config: FittingConfig
): BezierSegment[] {
  if (points.length === 0) return [];
  
  if (points.length === 1) {
    const p = points[0];
    return [{
      p0: p,
      p1: p,
      p2: p,
      p3: p,
    }];
  }
  
  if (points.length === 2) {
    return [createLinearSegment(points[0], points[1])];
  }

  // 端点の接線ベクトルを計算
  const leftTangent = computeLeftTangent(points, 0);
  const rightTangent = computeRightTangent(points, points.length - 1);

  // 再帰的にフィット
  const sqTolerance = config.tolerance * config.tolerance;
  return fitCubic(points, leftTangent, rightTangent, sqTolerance, config.maxIterations);
}

/**
 * 2点間の直線的なベジェセグメントを作成
 */
function createLinearSegment(p0: InputPoint, p3: InputPoint): BezierSegment {
  const dist = distance(p0, p3) / 3;
  const dx = p3.x - p0.x;
  const dy = p3.y - p0.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  
  if (len < 1e-10) {
    return { p0, p1: p0, p2: p3, p3 };
  }
  
  const ux = dx / len;
  const uy = dy / len;
  
  return {
    p0,
    p1: { x: p0.x + ux * dist, y: p0.y + uy * dist },
    p2: { x: p3.x - ux * dist, y: p3.y - uy * dist },
    p3,
  };
}

/**
 * 3次ベジェ曲線をフィット（再帰）
 */
function fitCubic(
  points: InputPoint[],
  leftTangent: Point,
  rightTangent: Point,
  sqTolerance: number,
  maxIterations: number
): BezierSegment[] {
  if (points.length === 2) {
    const dist = distance(points[0], points[1]) / 3;
    return [{
      p0: points[0],
      p1: {
        x: points[0].x + leftTangent.x * dist,
        y: points[0].y + leftTangent.y * dist,
      },
      p2: {
        x: points[1].x + rightTangent.x * dist,
        y: points[1].y + rightTangent.y * dist,
      },
      p3: points[1],
    }];
  }

  // パラメータ t を弦長比で初期化
  let u = chordLengthParameterize(points);

  // 最小二乗法でベジェ曲線を生成
  let bezier = generateBezier(points, u, leftTangent, rightTangent);

  // 最大誤差を計算
  let { maxError, splitPoint } = computeMaxError(points, bezier, u);

  // 許容誤差内ならそのまま返す
  if (maxError < sqTolerance) {
    return [bezier];
  }

  // 誤差が許容範囲に近い場合はパラメータを再調整
  if (maxError < sqTolerance * 4) {
    for (let i = 0; i < maxIterations; i++) {
      const uPrime = reparameterize(points, u, bezier);
      bezier = generateBezier(points, uPrime, leftTangent, rightTangent);
      const result = computeMaxError(points, bezier, uPrime);
      maxError = result.maxError;
      splitPoint = result.splitPoint;

      if (maxError < sqTolerance) {
        return [bezier];
      }

      u = uPrime;
    }
  }

  // フィット失敗：分割点で再帰
  const centerTangent = computeCenterTangent(points, splitPoint);
  const leftSegments = fitCubic(
    points.slice(0, splitPoint + 1),
    leftTangent,
    centerTangent,
    sqTolerance,
    maxIterations
  );
  const rightSegments = fitCubic(
    points.slice(splitPoint),
    negate(centerTangent),
    rightTangent,
    sqTolerance,
    maxIterations
  );

  return [...leftSegments, ...rightSegments];
}

/**
 * 最小二乗法でベジェ曲線を生成
 */
function generateBezier(
  points: InputPoint[],
  u: number[],
  leftTangent: Point,
  rightTangent: Point
): BezierSegment {
  const p0 = points[0];
  const p3 = points[points.length - 1];

  // A 行列を構築
  const A: [Point, Point][] = [];
  for (let i = 0; i < points.length; i++) {
    const t = u[i];
    const t2 = t * t;
    const mt = 1 - t;
    const mt2 = mt * mt;

    A.push([
      { x: leftTangent.x * 3 * mt2 * t, y: leftTangent.y * 3 * mt2 * t },
      { x: rightTangent.x * 3 * mt * t2, y: rightTangent.y * 3 * mt * t2 },
    ]);
  }

  // C と X を計算
  let C00 = 0, C01 = 0, C11 = 0;
  let X0 = 0, X1 = 0;

  for (let i = 0; i < points.length; i++) {
    C00 += dot(A[i][0], A[i][0]);
    C01 += dot(A[i][0], A[i][1]);
    C11 += dot(A[i][1], A[i][1]);

    const t = u[i];
    const t2 = t * t;
    const t3 = t2 * t;
    const mt = 1 - t;
    const mt2 = mt * mt;
    const mt3 = mt2 * mt;

    const tmp: Point = {
      x: points[i].x - (p0.x * mt3 + p0.x * 3 * mt2 * t + p3.x * 3 * mt * t2 + p3.x * t3),
      y: points[i].y - (p0.y * mt3 + p0.y * 3 * mt2 * t + p3.y * 3 * mt * t2 + p3.y * t3),
    };

    X0 += dot(A[i][0], tmp);
    X1 += dot(A[i][1], tmp);
  }

  // 連立方程式を解く
  const detC = C00 * C11 - C01 * C01;
  let alpha0: number, alpha1: number;

  if (Math.abs(detC) < 1e-6) {
    const c = distance(p0, p3) / 3;
    alpha0 = c;
    alpha1 = c;
  } else {
    alpha0 = (C11 * X0 - C01 * X1) / detC;
    alpha1 = (C00 * X1 - C01 * X0) / detC;
  }

  // alpha が負または非常に小さい場合のフォールバック
  const segLength = distance(p0, p3);
  const epsilon = 1e-6 * segLength;

  if (alpha0 < epsilon || alpha1 < epsilon) {
    alpha0 = alpha1 = segLength / 3;
  }

  return {
    p0,
    p1: { x: p0.x + leftTangent.x * alpha0, y: p0.y + leftTangent.y * alpha0 },
    p2: { x: p3.x + rightTangent.x * alpha1, y: p3.y + rightTangent.y * alpha1 },
    p3,
  };
}

/**
 * パラメータを再調整（Newton-Raphson法）
 */
function reparameterize(
  points: InputPoint[],
  u: number[],
  bezier: BezierSegment
): number[] {
  return u.map((t, i) => newtonRaphsonRootFind(bezier, points[i], t));
}

/**
 * Newton-Raphson法でパラメータを最適化
 */
function newtonRaphsonRootFind(
  bezier: BezierSegment,
  point: InputPoint,
  u: number
): number {
  const q = evaluateBezier(bezier, u);
  const q1 = evaluateBezierDerivative(bezier, u);
  const q2 = evaluateBezierSecondDerivative(bezier, u);

  const dx = q.x - point.x;
  const dy = q.y - point.y;

  const numerator = dx * q1.x + dy * q1.y;
  const denominator = q1.x * q1.x + q1.y * q1.y + dx * q2.x + dy * q2.y;

  if (Math.abs(denominator) < 1e-6) {
    return u;
  }

  const newU = u - numerator / denominator;
  return Math.max(0, Math.min(1, newU));
}

/**
 * ベジェ曲線上の点を評価
 */
function evaluateBezier(b: BezierSegment, t: number): Point {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const mt3 = mt2 * mt;
  const t2 = t * t;
  const t3 = t2 * t;

  return {
    x: mt3 * b.p0.x + 3 * mt2 * t * b.p1.x + 3 * mt * t2 * b.p2.x + t3 * b.p3.x,
    y: mt3 * b.p0.y + 3 * mt2 * t * b.p1.y + 3 * mt * t2 * b.p2.y + t3 * b.p3.y,
  };
}

/**
 * ベジェ曲線の1次導関数
 */
function evaluateBezierDerivative(b: BezierSegment, t: number): Point {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const t2 = t * t;

  return {
    x: 3 * mt2 * (b.p1.x - b.p0.x) + 6 * mt * t * (b.p2.x - b.p1.x) + 3 * t2 * (b.p3.x - b.p2.x),
    y: 3 * mt2 * (b.p1.y - b.p0.y) + 6 * mt * t * (b.p2.y - b.p1.y) + 3 * t2 * (b.p3.y - b.p2.y),
  };
}

/**
 * ベジェ曲線の2次導関数
 */
function evaluateBezierSecondDerivative(b: BezierSegment, t: number): Point {
  const mt = 1 - t;

  return {
    x: 6 * mt * (b.p2.x - 2 * b.p1.x + b.p0.x) + 6 * t * (b.p3.x - 2 * b.p2.x + b.p1.x),
    y: 6 * mt * (b.p2.y - 2 * b.p1.y + b.p0.y) + 6 * t * (b.p3.y - 2 * b.p2.y + b.p1.y),
  };
}

/**
 * 最大誤差と分割点を計算
 */
function computeMaxError(
  points: InputPoint[],
  bezier: BezierSegment,
  u: number[]
): { maxError: number; splitPoint: number } {
  let maxError = 0;
  let splitPoint = Math.floor(points.length / 2);

  for (let i = 1; i < points.length - 1; i++) {
    const p = evaluateBezier(bezier, u[i]);
    const dx = p.x - points[i].x;
    const dy = p.y - points[i].y;
    const distSq = dx * dx + dy * dy;

    if (distSq > maxError) {
      maxError = distSq;
      splitPoint = i;
    }
  }

  return { maxError, splitPoint };
}

/**
 * 左端点の接線ベクトル
 */
function computeLeftTangent(points: InputPoint[], end: number): Point {
  return normalize({
    x: points[end + 1].x - points[end].x,
    y: points[end + 1].y - points[end].y,
  });
}

/**
 * 右端点の接線ベクトル
 */
function computeRightTangent(points: InputPoint[], end: number): Point {
  return normalize({
    x: points[end - 1].x - points[end].x,
    y: points[end - 1].y - points[end].y,
  });
}

/**
 * 中間点の接線ベクトル
 */
function computeCenterTangent(points: InputPoint[], center: number): Point {
  const v1 = {
    x: points[center - 1].x - points[center].x,
    y: points[center - 1].y - points[center].y,
  };
  const v2 = {
    x: points[center].x - points[center + 1].x,
    y: points[center].y - points[center + 1].y,
  };
  return normalize({
    x: (v1.x + v2.x) / 2,
    y: (v1.y + v2.y) / 2,
  });
}
