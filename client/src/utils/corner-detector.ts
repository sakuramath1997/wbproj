/**
 * 曲線フィッティング - コーナー検出
 * 
 * 複数の手法を組み合わせてコーナーを検出:
 * 1. 角度ベース: 連続する点間の方向変化
 * 2. 曲率ベース: 離散曲率のピーク検出（漢字の折れ・数式の角に有効）
 * 3. 速度ベース: 方向転換時の速度低下
 * 4. 筆圧ベース: とめ・はねでの圧力変化
 */

import type { InputPoint, Corner, CornerDetectionConfig } from './curve-types';
import { 
  angleBetween, 
  toRadians, 
  calculateVelocities, 
  smoothVelocities,
  distance
} from './math';

/**
 * コーナーを検出
 */
export function detectCorners(
  points: InputPoint[],
  config: CornerDetectionConfig
): Corner[] {
  if (points.length < 3) return [];

  // 各検出手法でコーナー候補を取得
  const angleCandidates = detectByAngle(points, config);
  const curvatureCandidates = config.useCurvature
    ? detectByCurvature(points, config)
    : [];
  const velocityCandidates = config.useVelocity 
    ? detectByVelocity(points, config) 
    : [];
  const pressureCandidates = config.usePressure 
    ? detectByPressure(points, config) 
    : [];

  // 候補をマージ
  const allCandidates = mergeCandidates([
    angleCandidates,
    curvatureCandidates,
    velocityCandidates,
    pressureCandidates,
  ]);

  // 信頼度でソートし、近接するコーナーを除去
  return filterCorners(allCandidates, config.minCornerDistance);
}

/**
 * 角度ベースのコーナー検出
 */
function detectByAngle(
  points: InputPoint[],
  config: CornerDetectionConfig
): Corner[] {
  const corners: Corner[] = [];
  const threshold = toRadians(180 - config.angleThreshold);
  const windowSize = config.windowSize;

  for (let i = windowSize; i < points.length - windowSize; i++) {
    // ウィンドウ内の点で角度を計算
    const p1 = points[i - windowSize];
    const p2 = points[i];
    const p3 = points[i + windowSize];

    const angle = angleBetween(p1, p2, p3);

    if (angle < threshold) {
      // 角度が小さい = 急な方向変化
      const confidence = 1 - (angle / Math.PI);
      corners.push({
        index: i,
        point: points[i],
        angle,
        confidence: confidence * 0.8, // 角度検出の基本信頼度
        source: 'angle',
      });
    }
  }

  return corners;
}

/**
 * 曲率ベースのコーナー検出
 * 
 * 離散曲率 κ を計算し、局所的なピークをコーナーとして検出する。
 * 漢字の「折れ」(例: 「口」の角) や数式の記号 (Σ, ∫ のカーブ変化) に有効。
 * 
 * 離散曲率: κ_i = 2 * |sin(θ_i)| / max(|p_{i-1} - p_i| + |p_i - p_{i+1}|, ε)
 *   θ_i は p_{i-1}, p_i, p_{i+1} がなす角
 *   辺長で割ることでスケール不変にする
 */
function detectByCurvature(
  points: InputPoint[],
  config: CornerDetectionConfig
): Corner[] {
  if (points.length < 5) return [];

  // 離散曲率を計算
  const curvatures: number[] = new Array(points.length).fill(0);
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const next = points[i + 1];

    const d1 = distance(prev, curr);
    const d2 = distance(curr, next);
    const denom = d1 + d2;

    if (denom < 1e-6) continue;

    const angle = angleBetween(prev, curr, next);
    // κ = 2 * sin(θ/2) / ((d1+d2)/2)  ≈ 2*|sin(θ)| / (d1+d2) for supplementary form
    // ここでは angle が 0~π なので、π-angle が「曲がり角」
    curvatures[i] = 2 * Math.sin((Math.PI - angle) / 2) / (denom / 2);
  }

  // 移動平均で平滑化（ノイズ除去）
  const smoothed = smoothCurvatures(curvatures, 3);

  // 平均曲率を計算
  let sum = 0, count = 0;
  for (let i = 1; i < smoothed.length - 1; i++) {
    if (smoothed[i] > 0) { sum += smoothed[i]; count++; }
  }
  const avgCurvature = count > 0 ? sum / count : 0;
  if (avgCurvature < 1e-8) return [];

  // 閾値: 平均曲率に対する倍率
  const threshold = avgCurvature / config.curvatureThreshold;

  // 局所的なピークを検出
  const corners: Corner[] = [];
  for (let i = 2; i < smoothed.length - 2; i++) {
    const k = smoothed[i];
    if (k > threshold &&
        k >= smoothed[i - 1] &&
        k >= smoothed[i + 1] &&
        k >= smoothed[i - 2] &&
        k >= smoothed[i + 2]) {
      
      // 信頼度: 曲率が高いほど高信頼
      const confidence = Math.min(k / (avgCurvature * 3), 1) * 0.7;
      corners.push({
        index: i,
        point: points[i],
        angle: angleBetween(points[i - 1], points[i], points[i + 1]),
        confidence,
        source: 'curvature',
      });
    }
  }

  return corners;
}

/**
 * 曲率の移動平均
 */
function smoothCurvatures(values: number[], windowSize: number): number[] {
  const half = Math.floor(windowSize / 2);
  const result: number[] = new Array(values.length).fill(0);
  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - half);
    const end = Math.min(values.length, i + half + 1);
    let sum = 0;
    for (let j = start; j < end; j++) sum += values[j];
    result[i] = sum / (end - start);
  }
  return result;
}

/**
 * 速度ベースのコーナー検出
 */
function detectByVelocity(
  points: InputPoint[],
  config: CornerDetectionConfig
): Corner[] {
  // タイムスタンプがない場合はスキップ
  if (!points.some(p => p.timestamp !== undefined)) {
    return [];
  }

  const corners: Corner[] = [];
  const velocities = calculateVelocities(points);
  const smoothed = smoothVelocities(velocities, 5);
  
  // 平均速度を計算
  const avgVelocity = smoothed.reduce((a, b) => a + b, 0) / smoothed.length;
  const threshold = avgVelocity * config.velocityThreshold;

  // 局所的な最小値を探す
  for (let i = 2; i < smoothed.length - 2; i++) {
    const v = smoothed[i];
    
    // 速度が閾値以下で、かつ局所的な最小値
    if (v < threshold &&
        v <= smoothed[i - 1] &&
        v <= smoothed[i + 1] &&
        v <= smoothed[i - 2] &&
        v <= smoothed[i + 2]) {
      
      const confidence = 1 - (v / avgVelocity);
      corners.push({
        index: i,
        point: points[i],
        angle: Math.PI, // 角度情報なし
        confidence: Math.min(confidence, 1) * 0.6, // 速度検出の信頼度は低め
        source: 'velocity',
      });
    }
  }

  return corners;
}

/**
 * 筆圧ベースのコーナー検出
 */
function detectByPressure(
  points: InputPoint[],
  config: CornerDetectionConfig
): Corner[] {
  // 筆圧情報がない場合はスキップ
  if (!points.some(p => p.pressure !== undefined)) {
    return [];
  }

  const corners: Corner[] = [];
  const threshold = config.pressureThreshold;

  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1].pressure ?? 0.5;
    const curr = points[i].pressure ?? 0.5;
    const next = points[i + 1].pressure ?? 0.5;

    // 筆圧の急激な変化を検出
    const change = Math.abs(curr - prev) + Math.abs(curr - next);
    
    if (change > threshold) {
      corners.push({
        index: i,
        point: points[i],
        angle: Math.PI,
        confidence: Math.min(change, 1) * 0.5, // 筆圧検出の信頼度
        source: 'pressure',
      });
    }
  }

  return corners;
}

/**
 * 複数の検出結果をマージ
 */
function mergeCandidates(candidateLists: Corner[][]): Corner[] {
  const indexMap = new Map<number, Corner>();

  for (const candidates of candidateLists) {
    for (const corner of candidates) {
      const existing = indexMap.get(corner.index);
      
      if (existing) {
        // 同じインデックスのコーナーは信頼度を合成
        indexMap.set(corner.index, {
          ...existing,
          confidence: Math.min(existing.confidence + corner.confidence, 1),
          // より小さい角度（より急な変化）を採用
          angle: Math.min(existing.angle, corner.angle),
          // 複数ソースでブーストされた場合は最初のソースを維持
          source: existing.source,
        });
      } else {
        indexMap.set(corner.index, corner);
      }
    }
  }

  return Array.from(indexMap.values());
}

/**
 * 近接するコーナーを除去
 */
function filterCorners(corners: Corner[], minDistance: number): Corner[] {
  if (corners.length === 0) return [];

  // 信頼度で降順ソート
  const sorted = [...corners].sort((a, b) => b.confidence - a.confidence);
  const result: Corner[] = [];
  const usedIndices = new Set<number>();

  for (const corner of sorted) {
    // 既存のコーナーとの距離をチェック
    let tooClose = false;
    
    for (const used of usedIndices) {
      if (Math.abs(corner.index - used) < minDistance) {
        tooClose = true;
        break;
      }
    }

    if (!tooClose) {
      result.push(corner);
      usedIndices.add(corner.index);
    }
  }

  // インデックス順にソートして返す
  return result.sort((a, b) => a.index - b.index);
}

/**
 * コーナーで点列をセグメントに分割
 */
export function splitAtCorners(
  points: InputPoint[],
  corners: Corner[]
): InputPoint[][] {
  if (corners.length === 0) {
    return [points];
  }

  const segments: InputPoint[][] = [];
  let startIndex = 0;

  for (const corner of corners) {
    // コーナーまでのセグメント（コーナー点を含む）
    if (corner.index > startIndex) {
      segments.push(points.slice(startIndex, corner.index + 1));
    }
    startIndex = corner.index;
  }

  // 最後のセグメント
  if (startIndex < points.length - 1) {
    segments.push(points.slice(startIndex));
  }

  return segments;
}
