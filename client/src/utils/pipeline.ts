/**
 * 曲線フィッティング - パイプライン
 * 
 * プラグイン可能なステージアーキテクチャ:
 *   CurvePipeline は PipelineStage の配列を順番に実行する。
 *   各ステージは PipelineContext を受け取り、変更して返す。
 *   ステージの追加・削除・差し替えが可能で、プリセットも提供する。
 * 
 * デフォルトパイプライン:
 *   1. PreprocessStage    — 重複除去、ノイズフィルタ
 *   2. CornerDetectStage  — 角度+曲率+速度+筆圧によるコーナー検出
 *   3. SegmentSplitStage  — コーナーでセグメント分割
 *   4. BezierFitStage     — Schneider法による各セグメントのベジェフィット
 */

import type { 
  InputPoint, 
  BezierSegment, 
  CurveFittingConfig,
  PipelineContext,
  PipelineStage,
} from './curve-types';
import { DEFAULT_CONFIG } from './config';
import { removeDuplicates, applyMovingAverage } from './math';
import { detectCorners, splitAtCorners } from './corner-detector';
import { fitBezier } from './bezier-fitter';

// ========================================
// ビルトインステージ実装
// ========================================

/**
 * 前処理ステージ: 重複点除去 + ノイズフィルタ
 */
export class PreprocessStage implements PipelineStage {
  readonly name = 'preprocess';

  process(ctx: PipelineContext, config: CurveFittingConfig): PipelineContext {
    let pts = ctx.originalPoints;
    pts = removeDuplicates(pts, config.preprocess.duplicateThreshold);
    if (config.preprocess.applyNoiseFilter && pts.length > config.preprocess.noiseFilterWindow) {
      pts = applyMovingAverage(pts, config.preprocess.noiseFilterWindow);
    }
    return { ...ctx, processedPoints: pts };
  }
}

/**
 * コーナー検出ステージ
 */
export class CornerDetectStage implements PipelineStage {
  readonly name = 'corner-detect';

  process(ctx: PipelineContext, config: CurveFittingConfig): PipelineContext {
    const corners = detectCorners(ctx.processedPoints, config.cornerDetection);
    return { ...ctx, corners };
  }
}

/**
 * セグメント分割ステージ: コーナーで点列を分割
 */
export class SegmentSplitStage implements PipelineStage {
  readonly name = 'segment-split';

  process(ctx: PipelineContext, _config: CurveFittingConfig): PipelineContext {
    const segmentPoints = splitAtCorners(ctx.processedPoints, ctx.corners);
    const segments = segmentPoints.map((pts, i) => ({
      points: pts,
      startCorner: i > 0 ? ctx.corners[i - 1] : undefined,
      endCorner: i < ctx.corners.length ? ctx.corners[i] : undefined,
    }));
    return { ...ctx, segments };
  }
}

/**
 * ベジェフィットステージ: Schneider法で各セグメントをフィッティング
 */
export class BezierFitStage implements PipelineStage {
  readonly name = 'bezier-fit';

  process(ctx: PipelineContext, config: CurveFittingConfig): PipelineContext {
    const bezierSegments: BezierSegment[] = [];
    for (const segment of ctx.segments) {
      if (segment.points.length >= 2) {
        bezierSegments.push(...fitBezier(segment.points, config.fitting));
      } else if (segment.points.length === 1) {
        const p = segment.points[0];
        bezierSegments.push({ p0: p, p1: p, p2: p, p3: p });
      }
    }
    return { ...ctx, bezierSegments };
  }
}

// ========================================
// パイプラインクラス
// ========================================

/**
 * カスタマイズ可能な曲線フィッティングパイプライン
 * 
 * 使用例:
 *   // デフォルトパイプラインで実行
 *   const segments = fitCurve(points);
 * 
 *   // カスタムステージを追加
 *   const pipeline = CurvePipeline.default();
 *   pipeline.insertBefore('bezier-fit', new MyCustomStage());
 *   const result = pipeline.run(points, config);
 * 
 *   // ステージを差し替え
 *   pipeline.replace('corner-detect', new MyCornerDetector());
 */
export class CurvePipeline {
  private stages: PipelineStage[];

  constructor(stages: PipelineStage[]) {
    this.stages = [...stages];
  }

  /** デフォルトパイプラインを生成 */
  static default(): CurvePipeline {
    return new CurvePipeline([
      new PreprocessStage(),
      new CornerDetectStage(),
      new SegmentSplitStage(),
      new BezierFitStage(),
    ]);
  }

  /** パイプラインを実行 */
  run(points: InputPoint[], config: CurveFittingConfig): PipelineContext {
    let ctx: PipelineContext = {
      originalPoints: points,
      processedPoints: [],
      corners: [],
      segments: [],
      bezierSegments: [],
      meta: {},
    };

    // 点が少なすぎる場合の早期リターン
    if (points.length < 2) {
      if (points.length === 1) {
        ctx.bezierSegments = [{ p0: points[0], p1: points[0], p2: points[0], p3: points[0] }];
      }
      return ctx;
    }

    for (const stage of this.stages) {
      ctx = stage.process(ctx, config);
    }

    return ctx;
  }

  /** ステージ名一覧 */
  getStageNames(): string[] {
    return this.stages.map(s => s.name);
  }

  /** 名前でステージを差し替え */
  replace(name: string, newStage: PipelineStage): this {
    const idx = this.stages.findIndex(s => s.name === name);
    if (idx >= 0) {
      this.stages[idx] = newStage;
    }
    return this;
  }

  /** 指定ステージの前に挿入 */
  insertBefore(name: string, newStage: PipelineStage): this {
    const idx = this.stages.findIndex(s => s.name === name);
    if (idx >= 0) {
      this.stages.splice(idx, 0, newStage);
    } else {
      this.stages.push(newStage);
    }
    return this;
  }

  /** 指定ステージの後に挿入 */
  insertAfter(name: string, newStage: PipelineStage): this {
    const idx = this.stages.findIndex(s => s.name === name);
    if (idx >= 0) {
      this.stages.splice(idx + 1, 0, newStage);
    } else {
      this.stages.push(newStage);
    }
    return this;
  }

  /** ステージを末尾に追加 */
  append(stage: PipelineStage): this {
    this.stages.push(stage);
    return this;
  }

  /** 名前でステージを除去 */
  remove(name: string): this {
    this.stages = this.stages.filter(s => s.name !== name);
    return this;
  }
}

// ========================================
// 互換 API（既存コードから呼ばれる関数群）
// ========================================

/** デフォルトパイプラインインスタンス（シングルトン） */
let defaultPipeline: CurvePipeline | null = null;

function getDefaultPipeline(): CurvePipeline {
  if (!defaultPipeline) defaultPipeline = CurvePipeline.default();
  return defaultPipeline;
}

/**
 * デフォルトパイプラインを差し替える（グローバル設定）
 */
export function setDefaultPipeline(pipeline: CurvePipeline): void {
  defaultPipeline = pipeline;
}

/**
 * 曲線フィッティングを実行
 */
export function fitCurve(
  points: InputPoint[],
  config: Partial<CurveFittingConfig> = {}
): BezierSegment[] {
  const fullConfig = mergeWithDefaults(config);
  const ctx = getDefaultPipeline().run(points, fullConfig);
  return ctx.bezierSegments;
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
  return getDefaultPipeline().run(points, fullConfig);
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
