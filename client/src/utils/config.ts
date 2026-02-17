/**
 * 曲線フィッティング - 設定とプリセット
 */

import type { CurveFittingConfig, CornerDetectionConfig, FittingConfig, PreprocessConfig } from './curve-types';

/** デフォルトの前処理設定 */
export const DEFAULT_PREPROCESS_CONFIG: PreprocessConfig = {
  duplicateThreshold: 0.5,
  applyNoiseFilter: false,
  noiseFilterWindow: 3,
};

/** デフォルトのコーナー検出設定 */
export const DEFAULT_CORNER_DETECTION_CONFIG: CornerDetectionConfig = {
  angleThreshold: 30,          // 30度以上の角度変化
  windowSize: 3,               // 前後3点で角度計算
  velocityThreshold: 0.3,      // 平均の30%以下に速度低下
  useVelocity: true,
  usePressure: false,          // 筆圧は環境依存なのでデフォルトOFF
  pressureThreshold: 0.2,
  minCornerDistance: 5,        // コーナー間は最低5点
};

/** デフォルトのフィッティング設定 */
export const DEFAULT_FITTING_CONFIG: FittingConfig = {
  tolerance: 2.0,
  maxIterations: 4,
};

/** デフォルト設定（全体） */
export const DEFAULT_CONFIG: CurveFittingConfig = {
  preprocess: DEFAULT_PREPROCESS_CONFIG,
  cornerDetection: DEFAULT_CORNER_DETECTION_CONFIG,
  fitting: DEFAULT_FITTING_CONFIG,
};

/**
 * プリセット: 手書き文字向け
 * - コーナー検出を厳しめに
 * - 速度ベース検出ON
 */
export const PRESET_HANDWRITING: CurveFittingConfig = {
  preprocess: {
    duplicateThreshold: 0.5,
    applyNoiseFilter: true,
    noiseFilterWindow: 3,
  },
  cornerDetection: {
    angleThreshold: 25,         // より小さい角度も検出
    windowSize: 3,
    velocityThreshold: 0.35,
    useVelocity: true,
    usePressure: false,
    pressureThreshold: 0.2,
    minCornerDistance: 3,       // 文字は細かい角が多い
  },
  fitting: {
    tolerance: 1.5,             // より精密に
    maxIterations: 4,
  },
};

/**
 * プリセット: フリーハンド描画向け
 * - 滑らかさ重視
 * - コーナー検出は緩め
 */
export const PRESET_FREEHAND: CurveFittingConfig = {
  preprocess: {
    duplicateThreshold: 0.5,
    applyNoiseFilter: false,
    noiseFilterWindow: 3,
  },
  cornerDetection: {
    angleThreshold: 45,         // 明確な角のみ
    windowSize: 5,              // より広い範囲で判定
    velocityThreshold: 0.2,
    useVelocity: true,
    usePressure: false,
    pressureThreshold: 0.2,
    minCornerDistance: 8,
  },
  fitting: {
    tolerance: 2.5,
    maxIterations: 4,
  },
};

/**
 * プリセット: 図形描画向け
 * - 角を厳密に保持
 * - 直線的なセグメントを優先
 */
export const PRESET_DIAGRAM: CurveFittingConfig = {
  preprocess: {
    duplicateThreshold: 0.5,
    applyNoiseFilter: true,
    noiseFilterWindow: 5,
  },
  cornerDetection: {
    angleThreshold: 20,
    windowSize: 4,
    velocityThreshold: 0.4,
    useVelocity: true,
    usePressure: false,
    pressureThreshold: 0.2,
    minCornerDistance: 4,
  },
  fitting: {
    tolerance: 3.0,             // 多少の誤差は許容
    maxIterations: 3,
  },
};

/** プリセット一覧 */
export const PRESETS = {
  default: DEFAULT_CONFIG,
  handwriting: PRESET_HANDWRITING,
  freehand: PRESET_FREEHAND,
  diagram: PRESET_DIAGRAM,
} as const;

export type PresetName = keyof typeof PRESETS;

/**
 * 設定をマージする
 */
export function mergeConfig(
  base: CurveFittingConfig,
  overrides: Partial<CurveFittingConfig>
): CurveFittingConfig {
  return {
    preprocess: { ...base.preprocess, ...overrides.preprocess },
    cornerDetection: { ...base.cornerDetection, ...overrides.cornerDetection },
    fitting: { ...base.fitting, ...overrides.fitting },
  };
}
