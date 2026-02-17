/**
 * 曲線フィッティング - 数学ユーティリティ
 */

import type { Point, InputPoint } from './curve-types';

/** 2点間の距離 */
export function distance(p1: Point, p2: Point): number {
  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** 2点間の距離の2乗 */
export function distanceSq(p1: Point, p2: Point): number {
  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  return dx * dx + dy * dy;
}

/** ベクトルの内積 */
export function dot(p1: Point, p2: Point): number {
  return p1.x * p2.x + p1.y * p2.y;
}

/** ベクトルの長さ */
export function length(p: Point): number {
  return Math.sqrt(p.x * p.x + p.y * p.y);
}

/** ベクトルの正規化 */
export function normalize(p: Point): Point {
  const len = length(p);
  if (len < 1e-10) return { x: 1, y: 0 };
  return { x: p.x / len, y: p.y / len };
}

/** ベクトルの反転 */
export function negate(p: Point): Point {
  return { x: -p.x, y: -p.y };
}

/** ベクトルの加算 */
export function add(p1: Point, p2: Point): Point {
  return { x: p1.x + p2.x, y: p1.y + p2.y };
}

/** ベクトルの減算 */
export function subtract(p1: Point, p2: Point): Point {
  return { x: p1.x - p2.x, y: p1.y - p2.y };
}

/** ベクトルのスカラー倍 */
export function scale(p: Point, s: number): Point {
  return { x: p.x * s, y: p.y * s };
}

/** 度をラジアンに変換 */
export function toRadians(degrees: number): number {
  return degrees * Math.PI / 180;
}

/** ラジアンを度に変換 */
export function toDegrees(radians: number): number {
  return radians * 180 / Math.PI;
}

/**
 * 3点がなす角度を計算（中間点での角度）
 * @returns ラジアン（0 - π）
 */
export function angleBetween(p1: Point, p2: Point, p3: Point): number {
  const v1 = subtract(p1, p2);
  const v2 = subtract(p3, p2);
  
  const len1 = length(v1);
  const len2 = length(v2);
  
  if (len1 < 1e-10 || len2 < 1e-10) return Math.PI;
  
  const cosAngle = dot(v1, v2) / (len1 * len2);
  // 数値誤差対策
  const clampedCos = Math.max(-1, Math.min(1, cosAngle));
  return Math.acos(clampedCos);
}

/**
 * 点列の速度を計算
 * @returns 各点での速度（ピクセル/ミリ秒）
 */
export function calculateVelocities(points: InputPoint[]): number[] {
  if (points.length < 2) return points.map(() => 0);
  
  const velocities: number[] = [0];
  
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    
    const dist = distance(prev, curr);
    const dt = (curr.timestamp ?? 0) - (prev.timestamp ?? 0);
    
    if (dt > 0) {
      velocities.push(dist / dt);
    } else {
      velocities.push(velocities[velocities.length - 1] || 0);
    }
  }
  
  return velocities;
}

/**
 * 速度の移動平均を計算
 */
export function smoothVelocities(velocities: number[], windowSize: number): number[] {
  const halfWindow = Math.floor(windowSize / 2);
  const result: number[] = [];
  
  for (let i = 0; i < velocities.length; i++) {
    const start = Math.max(0, i - halfWindow);
    const end = Math.min(velocities.length, i + halfWindow + 1);
    
    let sum = 0;
    for (let j = start; j < end; j++) {
      sum += velocities[j];
    }
    result.push(sum / (end - start));
  }
  
  return result;
}

/**
 * 重複点を除去
 */
export function removeDuplicates(points: InputPoint[], threshold: number): InputPoint[] {
  if (points.length === 0) return [];
  
  const result: InputPoint[] = [points[0]];
  
  for (let i = 1; i < points.length; i++) {
    if (distance(points[i], result[result.length - 1]) > threshold) {
      result.push(points[i]);
    }
  }
  
  return result;
}

/**
 * 移動平均によるノイズフィルタ
 */
export function applyMovingAverage(points: InputPoint[], windowSize: number): InputPoint[] {
  if (points.length <= windowSize) return points;
  
  const halfWindow = Math.floor(windowSize / 2);
  const result: InputPoint[] = [];
  
  for (let i = 0; i < points.length; i++) {
    const start = Math.max(0, i - halfWindow);
    const end = Math.min(points.length, i + halfWindow + 1);
    
    let sumX = 0, sumY = 0;
    for (let j = start; j < end; j++) {
      sumX += points[j].x;
      sumY += points[j].y;
    }
    
    const count = end - start;
    result.push({
      ...points[i],
      x: sumX / count,
      y: sumY / count,
    });
  }
  
  // 端点は元の位置を維持
  if (result.length > 0) {
    result[0] = { ...result[0], x: points[0].x, y: points[0].y };
    result[result.length - 1] = {
      ...result[result.length - 1],
      x: points[points.length - 1].x,
      y: points[points.length - 1].y,
    };
  }
  
  return result;
}

/**
 * 点列の総距離を計算
 */
export function totalLength(points: InputPoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += distance(points[i - 1], points[i]);
  }
  return total;
}

/**
 * 弦長パラメータ化
 */
export function chordLengthParameterize(points: InputPoint[]): number[] {
  if (points.length === 0) return [];
  if (points.length === 1) return [0];
  
  const u: number[] = [0];
  let total = 0;
  
  for (let i = 1; i < points.length; i++) {
    total += distance(points[i], points[i - 1]);
    u.push(total);
  }
  
  // 正規化
  if (total > 0) {
    for (let i = 1; i < u.length; i++) {
      u[i] /= total;
    }
  }
  
  return u;
}
