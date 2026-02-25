/**
 * core/render-context.ts — 描画コンテキスト抽象（Rust 移植対象）
 *
 * React 非依存。ブラウザ API 非依存。
 *
 * architecture-spec v1.4 §3.3 で wgpu が描画バックエンドとして指定されており、
 * Canvas 2D → wgpu への移行が確定事項であるため、プラットフォーム非依存の
 * 描画抽象を定義する。
 *
 * Web 環境では utils/canvas-render-context.ts で Canvas 2D 実装を注入する。
 * Rust 環境では render/context.rs で wgpu trait として定義する。
 */

/**
 * プラットフォーム非依存の画像ハンドル。
 * Web 環境では HTMLImageElement、Rust/wgpu 環境ではテクスチャハンドル等。
 */
export type ImageHandle = unknown;

/**
 * プラットフォーム非依存の描画コンテキスト。
 *
 * board-renderer.ts はこのインターフェースのみに依存し、
 * 具体的な描画バックエンドには依存しない。
 */
export interface RenderContext {
  /** 塗りつぶし矩形 */
  fillRect(x: number, y: number, w: number, h: number, color: string): void;

  /** SVG パスのストローク描画 */
  strokePath(svgPath: string, color: string, width: number): void;

  /** 画像描画（source rect → destination rect） */
  drawImage(
    handle: ImageHandle,
    sx: number, sy: number, sw: number, sh: number,
    dx: number, dy: number, dw: number, dh: number,
  ): void;

  /** 画像描画（destination のみ） */
  drawImageSimple(handle: ImageHandle, dx: number, dy: number, dw: number, dh: number): void;

  /** アフィン変換行列の設定 */
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;

  /** グローバル透過度の設定 */
  setGlobalAlpha(alpha: number): void;

  /** 描画状態の保存 */
  save(): void;

  /** 描画状態の復元 */
  restore(): void;

  /** 線端のスタイル設定 */
  setLineCap(cap: 'butt' | 'round' | 'square'): void;

  /** 線接合のスタイル設定 */
  setLineJoin(join: 'bevel' | 'miter' | 'round'): void;
}