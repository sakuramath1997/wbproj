/**
 * 曲線フィッティング - 型定義
 */

/** 入力点（タイムスタンプ・筆圧付き） */
export interface InputPoint {
  x: number;
  y: number;
  timestamp?: number;   // ミリ秒
  pressure?: number;    // 0.0 - 1.0
}

/** 基本的な2D点 */
export interface Point {
  x: number;
  y: number;
}

/** 3次ベジェ曲線セグメント */
export interface BezierSegment {
  p0: Point;  // 始点
  p1: Point;  // 制御点1
  p2: Point;  // 制御点2
  p3: Point;  // 終点
}

/** コーナー情報 */
export interface Corner {
  index: number;        // 点列中のインデックス
  point: InputPoint;    // コーナーの座標
  angle: number;        // 角度（ラジアン）
  confidence: number;   // 信頼度 (0.0 - 1.0)
}

/** セグメント（コーナー間の点列） */
export interface Segment {
  points: InputPoint[];
  startCorner?: Corner;
  endCorner?: Corner;
}

/** パイプラインの中間結果 */
export interface PipelineContext {
  /** 元の入力点列 */
  originalPoints: InputPoint[];
  /** 前処理済みの点列 */
  processedPoints: InputPoint[];
  /** 検出されたコーナー */
  corners: Corner[];
  /** セグメント分割結果 */
  segments: Segment[];
  /** フィッティング結果 */
  bezierSegments: BezierSegment[];
}

/** コーナー検出器のインターフェース */
export interface CornerDetector {
  name: string;
  detect(points: InputPoint[], config: CornerDetectionConfig): Corner[];
}

/** ベジェフィッターのインターフェース */
export interface BezierFitter {
  name: string;
  fit(points: InputPoint[], config: FittingConfig): BezierSegment[];
}

/** コーナー検出の設定 */
export interface CornerDetectionConfig {
  /** 角度変化の閾値（度） */
  angleThreshold: number;
  /** 角度計算に使う隣接点数 */
  windowSize: number;
  /** 速度低下の閾値（0.0 - 1.0、平均速度に対する比率） */
  velocityThreshold: number;
  /** 速度ベース検出を有効にするか */
  useVelocity: boolean;
  /** 筆圧ベース検出を有効にするか */
  usePressure: boolean;
  /** 筆圧変化の閾値 */
  pressureThreshold: number;
  /** コーナー同士の最小間隔（点数） */
  minCornerDistance: number;
}

/** フィッティングの設定 */
export interface FittingConfig {
  /** 許容誤差（ピクセル） */
  tolerance: number;
  /** Newton-Raphson法の最大反復回数 */
  maxIterations: number;
}

/** 前処理の設定 */
export interface PreprocessConfig {
  /** 重複点の除去閾値（ピクセル） */
  duplicateThreshold: number;
  /** ノイズフィルタを適用するか */
  applyNoiseFilter: boolean;
  /** ノイズフィルタの強度（移動平均のウィンドウサイズ） */
  noiseFilterWindow: number;
}

/** パイプライン全体の設定 */
export interface CurveFittingConfig {
  preprocess: PreprocessConfig;
  cornerDetection: CornerDetectionConfig;
  fitting: FittingConfig;
}
