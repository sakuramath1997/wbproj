/**
 * core/bg-delta.ts — 背景変更デルタ計算（Rust 移植対象）
 *
 * React 非依存。ブラウザ API 非依存。
 *
 * wbelx-spec v4 §2-2 に準拠:
 *   色プロパティは sRGB チャネルデルタ、列挙プロパティは prev/next 形式で記録する。
 *
 * impl-guide v4 §Undo/Redo「逆操作の導出規則」:
 *   色デルタ → 各チャネル符号反転, 列挙 → prev と next を交換
 */

import type { BackgroundConfig, BackgroundEvent, ColorDelta, EnumDelta, BgPattern } from './types';
import { computeSrgbChannelDelta, isZeroDelta } from './color';

/** BG イベントのデルタフィールド（type/timestamp/sessionId/id を除く） */
export interface BgDeltaFields {
  dColor?: ColorDelta;
  pattern?: EnumDelta<BgPattern>;
  dPatternSize?: number;
  dPatternColor?: ColorDelta;
}

/**
 * 現在の背景設定と新しい背景設定からデルタを計算する。
 * 変更がない場合は全フィールドが undefined のオブジェクトを返す。
 */
export function computeBgDelta(
  currentBg: BackgroundConfig,
  newBg: BackgroundConfig,
): BgDeltaFields {
  const result: BgDeltaFields = {};

  // 色デルタ
  const dColor = computeSrgbChannelDelta(currentBg.color, newBg.color);
  if (!isZeroDelta(dColor)) {
    result.dColor = dColor;
  }

  // パターン種別 (列挙デルタ)
  if (currentBg.pattern !== newBg.pattern) {
    result.pattern = { prev: currentBg.pattern, next: newBg.pattern };
  }

  // パターンサイズ (数値デルタ)
  const dPatternSize = newBg.patternSize - currentBg.patternSize;
  if (dPatternSize !== 0) {
    result.dPatternSize = dPatternSize;
  }

  // パターン色デルタ
  const dPatternColor = computeSrgbChannelDelta(currentBg.patternColor, newBg.patternColor);
  if (!isZeroDelta(dPatternColor)) {
    result.dPatternColor = dPatternColor;
  }

  return result;
}

/** デルタが空（変更なし）かどうかを判定する */
export function isEmptyBgDelta(delta: BgDeltaFields): boolean {
  return !delta.dColor && !delta.pattern && delta.dPatternSize === undefined && !delta.dPatternColor;
}

/**
 * 現在の背景設定と新しい背景設定から BG イベントを構築する。
 * 変更がない場合は null を返す。
 *
 * @param currentBg 現在の背景設定
 * @param newBg 新しい背景設定
 * @param sessionId セッション ID
 * @param generateId BG イベント ID 生成関数
 * @param getTimestamp タイムスタンプ取得関数
 */
export function buildBgEvent(
  currentBg: BackgroundConfig,
  newBg: BackgroundConfig,
  sessionId: string,
  generateId: () => string,
  getTimestamp: () => string,
): BackgroundEvent | null {
  const delta = computeBgDelta(currentBg, newBg);
  if (isEmptyBgDelta(delta)) return null;

  return {
    type: 'BG',
    timestamp: getTimestamp(),
    sessionId,
    id: generateId(),
    ...delta,
  };
}