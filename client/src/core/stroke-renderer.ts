/**
 * core/stroke-renderer.ts — ストローク/オーバーレイ描画ヘルパー（Rust 移植対象）
 *
 * React 非依存。ブラウザ API 非依存。
 *
 * Phase 5 で WhiteboardCanvas.tsx から抽出。
 * 純粋な幾何計算・座標変換・カーソル判定ロジックを提供する。
 *
 * architecture-spec v1.4 §3.1:
 *   L2（ストローク処理・描画層）に属する。
 *   将来的に whiteboard-core/src/render/ 配下に Rust 移植される。
 */

import type { ToolType } from './types';

// ========================================
// 座標変換
// ========================================

export interface CanvasTransform {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

/**
 * スクリーン座標 → キャンバス座標変換。
 * コンテナの左上を原点とし、transform (pan/zoom) を逆適用する。
 */
export function screenToCanvasCoord(
  screenX: number,
  screenY: number,
  containerLeft: number,
  containerTop: number,
  transform: CanvasTransform,
): { x: number; y: number } {
  const x = (screenX - containerLeft - transform.x) / transform.scale;
  const y = (screenY - containerTop - transform.y) / transform.scale;
  return { x, y };
}

// ========================================
// ズーム計算
// ========================================

/** ズーム範囲の制約定数 */
export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 5;

/**
 * ピンチズーム後の transform を計算する。
 * center: ピンチの中心点（スクリーン座標）
 */
export function computePinchZoom(
  prev: CanvasTransform,
  scaleFactor: number,
  center: { x: number; y: number },
  panDx: number,
  panDy: number,
): CanvasTransform {
  const newScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, prev.scale * scaleFactor));
  const scaleChange = newScale / prev.scale;
  const newX = center.x - (center.x - prev.x) * scaleChange + panDx;
  const newY = center.y - (center.y - prev.y) * scaleChange + panDy;
  return { x: newX, y: newY, scale: newScale };
}

/**
 * ホイールズーム後の transform を計算する。
 * mouseX, mouseY: コンテナ内のマウス位置
 */
export function computeWheelZoom(
  prev: CanvasTransform,
  deltaY: number,
  mouseX: number,
  mouseY: number,
): CanvasTransform {
  const zoomFactor = deltaY > 0 ? 0.9 : 1.1;
  const newScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, prev.scale * zoomFactor));
  const scaleChange = newScale / prev.scale;
  const newX = mouseX - (mouseX - prev.x) * scaleChange;
  const newY = mouseY - (mouseY - prev.y) * scaleChange;
  return { x: newX, y: newY, scale: newScale };
}

// ========================================
// 幾何判定
// ========================================

/**
 * 点が多角形の内部にあるかを判定（ray casting アルゴリズム）。
 * Lasso 投げ縄の選択判定で使用。
 */
export function pointInPolygon(
  px: number,
  py: number,
  polygon: ReadonlyArray<{ x: number; y: number }>,
): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * 点がハンドル領域内にあるかを判定する。
 */
export function isPointNearHandle(
  px: number,
  py: number,
  hx: number,
  hy: number,
  handleSize: number,
): boolean {
  return Math.abs(px - hx) < handleSize && Math.abs(py - hy) < handleSize;
}

/**
 * 点が矩形内にあるかを判定する。
 */
export function isPointInRect(
  px: number,
  py: number,
  x: number,
  y: number,
  w: number,
  h: number,
): boolean {
  return px >= x && px <= x + w && py >= y && py <= y + h;
}

// ========================================
// SVG パス変換
// ========================================

/**
 * SVG パス文字列を (dx, dy) だけ平行移動する。
 * fitCurveToSvgPath が生成する M/C 絶対座標パスを想定。
 */
export function offsetSvgPathCanvas(path: string, dx: number, dy: number): string {
  let idx = 0;
  return path.replace(/-?[\d.]+/g, (match) => {
    const val = parseFloat(match);
    const isX = idx % 2 === 0;
    idx++;
    return String(Math.round((val + (isX ? dx : dy)) * 100) / 100);
  });
}

/**
 * SVG パス文字列を原点 (ox, oy) 基準で (sx, sy) スケールする。
 * fitCurveToSvgPath が生成する M/C 絶対座標パスを想定。
 */
export function scaleSvgPath(
  path: string,
  sx: number,
  sy: number,
  ox: number,
  oy: number,
): string {
  let idx = 0;
  return path.replace(/-?[\d.]+/g, (match) => {
    const val = parseFloat(match);
    const isX = idx % 2 === 0;
    idx++;
    if (isX) {
      return String(Math.round((ox + (val - ox) * sx) * 100) / 100);
    } else {
      return String(Math.round((oy + (val - oy) * sy) * 100) / 100);
    }
  });
}

// ========================================
// リサイズ計算
// ========================================

/** ドラッグモード（オーバーレイ選択/投げ縄共通） */
export type ResizeMode = 'none' | 'move'
  | 'resize-nw' | 'resize-ne' | 'resize-se' | 'resize-sw'
  | 'resize-n' | 'resize-s' | 'resize-e' | 'resize-w';

/** 8 方向のリサイズハンドル位置を計算する */
export function computeResizeHandles(
  x: number, y: number, w: number, h: number,
): Array<{ mode: ResizeMode; hx: number; hy: number }> {
  const midX = x + w / 2;
  const midY = y + h / 2;
  return [
    { mode: 'resize-nw', hx: x, hy: y },
    { mode: 'resize-ne', hx: x + w, hy: y },
    { mode: 'resize-se', hx: x + w, hy: y + h },
    { mode: 'resize-sw', hx: x, hy: y + h },
    { mode: 'resize-n', hx: midX, hy: y },
    { mode: 'resize-s', hx: midX, hy: y + h },
    { mode: 'resize-w', hx: x, hy: midY },
    { mode: 'resize-e', hx: x + w, hy: midY },
  ];
}

/**
 * ハンドルのヒットテスト。
 * ヒットしたハンドルの mode を返す。ヒットなしは 'none'。
 */
export function hitTestResizeHandles(
  px: number,
  py: number,
  x: number,
  y: number,
  w: number,
  h: number,
  handleSize: number,
): ResizeMode {
  const handles = computeResizeHandles(x, y, w, h);
  for (const handle of handles) {
    if (isPointNearHandle(px, py, handle.hx, handle.hy, handleSize)) {
      return handle.mode;
    }
  }
  return 'none';
}

/** オーバーレイリサイズの計算結果 */
export interface ResizeResult {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * リサイズモードとドラッグ差分からリサイズ結果を計算する。
 *
 * @param mode リサイズモード
 * @param initial リサイズ開始時の矩形
 * @param dx ドラッグ x 差分
 * @param dy ドラッグ y 差分
 * @param lockAR アスペクト比をロックするか
 * @param minSize 最小サイズ（デフォルト 20）
 */
export function computeResize(
  mode: ResizeMode,
  initial: { x: number; y: number; width: number; height: number },
  dx: number,
  dy: number,
  lockAR: boolean,
  minSize: number = 20,
): ResizeResult {
  let newX = initial.x;
  let newY = initial.y;
  let newWidth = initial.width;
  let newHeight = initial.height;
  const aspectRatio = initial.width / initial.height;

  switch (mode) {
    case 'resize-nw':
      newX = initial.x + dx; newY = initial.y + dy;
      newWidth = initial.width - dx; newHeight = initial.height - dy;
      if (lockAR) { newHeight = newWidth / aspectRatio; newY = initial.y + initial.height - newHeight; }
      break;
    case 'resize-ne':
      newY = initial.y + dy;
      newWidth = initial.width + dx; newHeight = initial.height - dy;
      if (lockAR) { newHeight = newWidth / aspectRatio; newY = initial.y + initial.height - newHeight; }
      break;
    case 'resize-se':
      newWidth = initial.width + dx; newHeight = initial.height + dy;
      if (lockAR) { newHeight = newWidth / aspectRatio; }
      break;
    case 'resize-sw':
      newX = initial.x + dx;
      newWidth = initial.width - dx; newHeight = initial.height + dy;
      if (lockAR) { newHeight = newWidth / aspectRatio; }
      break;
    case 'resize-n':
      newY = initial.y + dy; newHeight = initial.height - dy;
      break;
    case 'resize-s':
      newHeight = initial.height + dy;
      break;
    case 'resize-e':
      newWidth = initial.width + dx;
      break;
    case 'resize-w':
      newX = initial.x + dx; newWidth = initial.width - dx;
      break;
  }

  // 最小サイズ保証
  if (newWidth < minSize) {
    if (mode === 'resize-nw' || mode === 'resize-sw' || mode === 'resize-w') {
      newX = initial.x + initial.width - minSize;
    }
    newWidth = minSize;
    if (lockAR && mode !== 'resize-w') { newHeight = newWidth / aspectRatio; }
  }
  if (newHeight < minSize) {
    if (mode === 'resize-nw' || mode === 'resize-ne' || mode === 'resize-n') {
      newY = initial.y + initial.height - minSize;
    }
    newHeight = minSize;
    if (lockAR && mode !== 'resize-n') { newWidth = newHeight * aspectRatio; }
  }

  return { x: newX, y: newY, width: newWidth, height: newHeight };
}

/**
 * 投げ縄リサイズモードからスケール係数と原点を計算する。
 */
export function computeLassoScale(
  mode: ResizeMode,
  dx: number,
  dy: number,
  bMinX: number,
  bMinY: number,
  bMaxX: number,
  bMaxY: number,
): { sx: number; sy: number; ox: number; oy: number } | null {
  const bw = bMaxX - bMinX;
  const bh = bMaxY - bMinY;
  if (bw < 1 || bh < 1) return null;

  let sx = 1, sy = 1;
  let ox: number, oy: number;

  switch (mode) {
    case 'resize-se': { const s = Math.max(0.05, (bw + dx) / bw); sx = sy = s; ox = bMinX; oy = bMinY; break; }
    case 'resize-sw': { const s = Math.max(0.05, (bw - dx) / bw); sx = sy = s; ox = bMaxX; oy = bMinY; break; }
    case 'resize-ne': { const s = Math.max(0.05, (bw + dx) / bw); sx = sy = s; ox = bMinX; oy = bMaxY; break; }
    case 'resize-nw': { const s = Math.max(0.05, (bw - dx) / bw); sx = sy = s; ox = bMaxX; oy = bMaxY; break; }
    case 'resize-e':  { sx = Math.max(0.05, (bw + dx) / bw); ox = bMinX; oy = bMinY; break; }
    case 'resize-w':  { sx = Math.max(0.05, (bw - dx) / bw); ox = bMaxX; oy = bMinY; break; }
    case 'resize-s':  { sy = Math.max(0.05, (bh + dy) / bh); ox = bMinX; oy = bMinY; break; }
    case 'resize-n':  { sy = Math.max(0.05, (bh - dy) / bh); ox = bMinX; oy = bMaxY; break; }
    default: return null;
  }

  return { sx, sy, ox, oy };
}

// ========================================
// カーソルスタイル
// ========================================

/**
 * ツールに対応する CSS カーソルスタイルを返す。
 */
export function getCursorForTool(tool: ToolType): string {
  switch (tool) {
    case 'pen': return 'crosshair';
    case 'eraser': return 'pointer';
    case 'pan': return 'grab';
    case 'select': return 'default';
    case 'lasso': return 'crosshair';
    default: return 'default';
  }
}

// ========================================
// BBox 計算ヘルパー
// ========================================

/** ストロークとオーバーレイから BBox を集約する */
export function computeSelectionBBox(
  strokes: ReadonlyArray<{ bbox?: [number, number, number, number] | null }>,
  overlays: ReadonlyArray<{ x: number; y: number; width: number; height: number }>,
): [number, number, number, number] | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const s of strokes) {
    if (s.bbox) {
      minX = Math.min(minX, s.bbox[0]); minY = Math.min(minY, s.bbox[1]);
      maxX = Math.max(maxX, s.bbox[2]); maxY = Math.max(maxY, s.bbox[3]);
    }
  }
  for (const ov of overlays) {
    minX = Math.min(minX, ov.x); minY = Math.min(minY, ov.y);
    maxX = Math.max(maxX, ov.x + ov.width); maxY = Math.max(maxY, ov.y + ov.height);
  }

  if (minX === Infinity) return null;
  return [minX, minY, maxX, maxY];
}
