/**
 * core/board-renderer.ts — ボードレンダリング計算（Rust 移植対象）
 *
 * React 非依存。ブラウザ API 非依存。
 *
 * 移動元: BoardEditor.tsx 内の renderBoardToImage（320–501行）
 *
 * NOTE: 現段階では純粋な計算ロジック（BBox 計算）のみを抽出する。
 * 実際の描画ロジックは RenderContext を介して Phase 2c で移行する。
 */

import type { DrawEvent, OverlayState } from './types';
import type { RenderContext, ImageHandle } from './render-context';

// ========================================
// コンテンツ BBox 計算
// ========================================

/**
 * ストロークとオーバーレイのコンテンツ BBox を計算する。
 * レンダリング範囲の決定に使用。
 *
 * @param margin BBox に追加するマージン（px）
 * @returns BBox {x, y, width, height} またはコンテンツがない場合 null
 */
export function computeContentBBox(
  strokes: ReadonlyArray<DrawEvent>,
  overlays: ReadonlyArray<OverlayState>,
  margin: number = 0,
): { x: number; y: number; width: number; height: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const s of strokes) {
    if (s.bbox) {
      minX = Math.min(minX, s.bbox[0]);
      minY = Math.min(minY, s.bbox[1]);
      maxX = Math.max(maxX, s.bbox[2]);
      maxY = Math.max(maxY, s.bbox[3]);
    }
  }

  for (const o of overlays) {
    minX = Math.min(minX, o.x);
    minY = Math.min(minY, o.y);
    maxX = Math.max(maxX, o.x + o.width);
    maxY = Math.max(maxY, o.y + o.height);
  }

  if (minX === Infinity) return null;

  return {
    x: minX - margin,
    y: minY - margin,
    width: maxX - minX + margin * 2,
    height: maxY - minY + margin * 2,
  };
}

// ========================================
// ボード描画パラメータ
// ========================================

export interface BoardRenderState {
  strokes: ReadonlyArray<DrawEvent>;
  overlays: ReadonlyArray<OverlayState>;
  background?: {
    color: string;
    pattern: string;
    patternSize: number;
    patternColor: string;
  };
}

export interface BoardRenderOptions {
  /** 出力幅（ピクセル） */
  width: number;
  /** 出力高さ（ピクセル） */
  height: number;
  /** ビューポート領域（null の場合はコンテンツ BBox を使用） */
  viewport?: { x: number; y: number; width: number; height: number } | null;
  /** 最大再帰深度（ボードオーバーレイの再帰描画制限） */
  maxDepth?: number;
}

/**
 * ボード状態からオフスクリーン描画を実行する。
 *
 * NOTE: Phase 2c で完全な実装に移行予定。現在は Canvas 2D 実装が
 * BoardEditor.tsx 内の renderBoardToImage に残っている。
 */
export function renderBoard(
  ctx: RenderContext,
  state: BoardRenderState,
  options: BoardRenderOptions,
  resolveImage: (assetUuid: string) => ImageHandle | null,
): void {
  const { width, height, viewport } = options;

  // 描画範囲の決定
  const vp = viewport ?? computeContentBBox(state.strokes, state.overlays) ?? { x: -960, y: -540, width: 1920, height: 1080 };
  const scale = width / vp.width;

  // 背景
  if (state.background) {
    ctx.fillRect(0, 0, width, height, state.background.color);
  }

  // オーバーレイ描画
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, -vp.x * scale, -vp.y * scale);
  for (const overlay of state.overlays) {
    ctx.save();
    ctx.setGlobalAlpha(overlay.opacity);
    const img = resolveImage(overlay.assetUuid);
    if (img) {
      if (overlay.viewport.width > 0 && overlay.viewport.height > 0) {
        ctx.drawImage(
          img,
          overlay.viewport.x, overlay.viewport.y, overlay.viewport.width, overlay.viewport.height,
          overlay.x, overlay.y, overlay.width, overlay.height,
        );
      } else {
        ctx.drawImageSimple(img, overlay.x, overlay.y, overlay.width, overlay.height);
      }
    } else {
      ctx.fillRect(overlay.x, overlay.y, overlay.width, overlay.height, '#d1d5db');
    }
    ctx.restore();
  }
  ctx.restore();

  // ストローク描画
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, -vp.x * scale, -vp.y * scale);
  ctx.setLineCap('round');
  ctx.setLineJoin('round');
  for (const stroke of state.strokes) {
    ctx.strokePath(stroke.path, stroke.color, stroke.width);
  }
  ctx.restore();
}
