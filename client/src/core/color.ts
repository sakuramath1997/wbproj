/**
 * core/color.ts — 色変換ユーティリティ（Rust 移植対象）
 *
 * React 非依存。ブラウザ API 非依存。
 *
 * wbelx-spec v4 §2-2 に準拠:
 *   色プロパティは {"space":"srgb","dr":+10,"dg":+10,"db":+10} 形式で
 *   sRGB チャネルデルタを記録する。
 */

import type { ColorDelta } from './types';

/** hex 文字列 (#rrggbb) を RGB チャネルにパースする */
export function parseHex(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/** RGB チャネルを hex 文字列 (#rrggbb) に変換する */
export function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return '#' + [clamp(r), clamp(g), clamp(b)]
    .map(v => v.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 2 つの hex 色の sRGB チャネルデルタを計算する。
 * wbelx-spec v4 §2-2 のデルタ記録方式に準拠。
 */
export function computeSrgbChannelDelta(
  oldHex: string,
  newHex: string,
): ColorDelta {
  const oldC = parseHex(oldHex);
  const newC = parseHex(newHex);
  return {
    space: 'srgb',
    dr: newC.r - oldC.r,
    dg: newC.g - oldC.g,
    db: newC.b - oldC.b,
  };
}

/** ColorDelta がゼロ（変更なし）かどうかを判定する */
export function isZeroDelta(delta: ColorDelta): boolean {
  return delta.dr === 0 && delta.dg === 0 && delta.db === 0;
}
