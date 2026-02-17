/**
 * 曲線フィッティング - パイプライン
 * 
 * 処理フロー:
 * 1. 前処理（重複除去、ノイズフィルタ）
 * 2. コーナー検出
 * 3. セグメント分割
 * 4. 各セグメントにベジェフィット
 * 5. 結果の統合
 */

import type { 
  InputPoint, 
  BezierSegment, 
  CurveFittingConfig,
  PipelineContext
} from './curve-types';
import { DEFAULT_CONFIG } from './config';
import { removeDuplicates, applyMovingAverage } from './math';
import { detectCorners, splitAtCorners } from './corner-detector';
import { fitBezier } from './bezier-fitter';

/**
 * 曲線フィッティングを実行
 * 
 * @param points 入力点列
 * @param config 設定（省略時はデフォルト）
 * @returns ベジェセグメントの配列
 */
export function fitCurve(
  points: InputPoint[],
  config: Partial<CurveFittingConfig> = {}
): BezierSegment[] {
  const fullConfig = mergeWithDefaults(config);
  const context = createPipeline(points, fullConfig);
  return context.bezierSegments;
}

/**
 * パイプラインを実行し、中間結果も含めて返す
 * （デバッグや可視化用）
 */
export function runPipeline(
  points: InputPoint[],
  config: Partial<CurveFittingConfig> = {}
): PipelineContext {
  const fullConfig = mergeWithDefaults(config);
  return createPipeline(points, fullConfig);
}

/**
 * ベジェセグメントをSVGパス文字列に変換
 */
export function toSvgPath(segments: BezierSegment[]): string {
  if (segments.length === 0) return '';

  const path: string[] = [];
  path.push(`M ${segments[0].p0.x.toFixed(2)} ${segments[0].p0.y.toFixed(2)}`);

  for (const seg of segments) {
    path.push(
      `C ${seg.p1.x.toFixed(2)} ${seg.p1.y.toFixed(2)} ` +
      `${seg.p2.x.toFixed(2)} ${seg.p2.y.toFixed(2)} ` +
      `${seg.p3.x.toFixed(2)} ${seg.p3.y.toFixed(2)}`
    );
  }

  return path.join(' ');
}

/**
 * 点列を直接SVGパスに変換（便利関数）
 */
export function fitCurveToSvgPath(
  points: InputPoint[],
  config: Partial<CurveFittingConfig> = {}
): string {
  const segments = fitCurve(points, config);
  return toSvgPath(segments);
}

// ========================================
// 内部関数
// ========================================

function mergeWithDefaults(config: Partial<CurveFittingConfig>): CurveFittingConfig {
  return {
    preprocess: { ...DEFAULT_CONFIG.preprocess, ...config.preprocess },
    cornerDetection: { ...DEFAULT_CONFIG.cornerDetection, ...config.cornerDetection },
    fitting: { ...DEFAULT_CONFIG.fitting, ...config.fitting },
  };
}

function createPipeline(
  points: InputPoint[],
  config: CurveFittingConfig
): PipelineContext {
  // 初期コンテキスト
  const context: PipelineContext = {
    originalPoints: points,
    processedPoints: [],
    corners: [],
    segments: [],
    bezierSegments: [],
  };

  // 点が少なすぎる場合
  if (points.length < 2) {
    if (points.length === 1) {
      context.bezierSegments = [{
        p0: points[0],
        p1: points[0],
        p2: points[0],
        p3: points[0],
      }];
    }
    return context;
  }

  // Step 1: 前処理
  context.processedPoints = preprocess(points, config);

  // 前処理後も点が少なすぎる場合
  if (context.processedPoints.length < 2) {
    context.bezierSegments = [{
      p0: context.processedPoints[0] || points[0],
      p1: context.processedPoints[0] || points[0],
      p2: context.processedPoints[0] || points[0],
      p3: context.processedPoints[0] || points[0],
    }];
    return context;
  }

  // Step 2: コーナー検出
  context.corners = detectCorners(context.processedPoints, config.cornerDetection);

  // Step 3: セグメント分割
  const segmentPoints = splitAtCorners(context.processedPoints, context.corners);
  context.segments = segmentPoints.map((pts, i) => ({
    points: pts,
    startCorner: i > 0 ? context.corners[i - 1] : undefined,
    endCorner: i < context.corners.length ? context.corners[i] : undefined,
  }));

  // Step 4: 各セグメントにベジェフィット
  for (const segment of context.segments) {
    if (segment.points.length >= 2) {
      const fitted = fitBezier(segment.points, config.fitting);
      context.bezierSegments.push(...fitted);
    } else if (segment.points.length === 1) {
      // 1点のみの場合は点として追加
      const p = segment.points[0];
      context.bezierSegments.push({ p0: p, p1: p, p2: p, p3: p });
    }
  }

  return context;
}

function preprocess(
  points: InputPoint[],
  config: CurveFittingConfig
): InputPoint[] {
  let processed = points;

  // 重複点の除去
  processed = removeDuplicates(processed, config.preprocess.duplicateThreshold);

  // ノイズフィルタ
  if (config.preprocess.applyNoiseFilter && processed.length > config.preprocess.noiseFilterWindow) {
    processed = applyMovingAverage(processed, config.preprocess.noiseFilterWindow);
  }

  return processed;
}
