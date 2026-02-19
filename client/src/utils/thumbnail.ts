/**
 * ボードサムネイル生成
 *
 * ストロークとオーバーレイの BBox から描画範囲を計算し、
 * オフスクリーン Canvas にレンダリングして PNG Blob を返す。
 */

import type { DrawEvent, OverlayState, BackgroundConfig } from '../types';

const THUMB_MAX_W = 400;
const THUMB_MAX_H = 300;
const MARGIN = 20;

/**
 * ボードの描画内容からサムネイル PNG を生成する。
 * オーバーレイ画像は省略し、プレースホルダー矩形で代替する（軽量化）。
 */
export function generateThumbnail(
  strokes: DrawEvent[],
  overlays: OverlayState[],
  bg?: BackgroundConfig,
): Blob | null {
  // コンテンツ BBox
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

  // 空のボード
  if (minX === Infinity) {
    minX = -200; minY = -150; maxX = 200; maxY = 150;
  }

  // マージン付き範囲
  minX -= MARGIN; minY -= MARGIN;
  maxX += MARGIN; maxY += MARGIN;

  const contentW = maxX - minX;
  const contentH = maxY - minY;
  const aspect = contentW / contentH;

  let thumbW: number, thumbH: number;
  if (aspect > THUMB_MAX_W / THUMB_MAX_H) {
    thumbW = THUMB_MAX_W;
    thumbH = Math.round(THUMB_MAX_W / aspect);
  } else {
    thumbH = THUMB_MAX_H;
    thumbW = Math.round(THUMB_MAX_H * aspect);
  }
  thumbW = Math.max(thumbW, 1);
  thumbH = Math.max(thumbH, 1);

  const scale = thumbW / contentW;

  const canvas = document.createElement('canvas');
  canvas.width = thumbW;
  canvas.height = thumbH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // 背景
  ctx.fillStyle = bg?.color || '#ffffff';
  ctx.fillRect(0, 0, thumbW, thumbH);

  ctx.save();
  ctx.scale(scale, scale);
  ctx.translate(-minX, -minY);

  // 背景パターン（簡易版: grid のみ描画）
  if (bg?.pattern === 'grid' || bg?.pattern === 'dots' || bg?.pattern === 'lines') {
    const gridSize = bg.patternSize || 20;
    ctx.strokeStyle = bg.patternColor || '#e0e0e0';
    ctx.lineWidth = 1 / scale;
    const gx0 = Math.floor(minX / gridSize) * gridSize;
    const gy0 = Math.floor(minY / gridSize) * gridSize;
    ctx.beginPath();
    if (bg.pattern === 'grid' || bg.pattern === 'lines') {
      for (let y = gy0; y <= maxY; y += gridSize) {
        ctx.moveTo(minX, y); ctx.lineTo(maxX, y);
      }
    }
    if (bg.pattern === 'grid') {
      for (let x = gx0; x <= maxX; x += gridSize) {
        ctx.moveTo(x, minY); ctx.lineTo(x, maxY);
      }
    }
    ctx.stroke();

    if (bg.pattern === 'dots') {
      ctx.fillStyle = bg.patternColor || '#e0e0e0';
      const radius = Math.max(1 / scale, 0.8);
      for (let x = gx0; x <= maxX; x += gridSize) {
        for (let y = gy0; y <= maxY; y += gridSize) {
          ctx.beginPath();
          ctx.arc(x, y, radius, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  // オーバーレイ（プレースホルダー矩形）
  for (const o of overlays) {
    ctx.save();
    ctx.globalAlpha = o.opacity;
    ctx.fillStyle = '#d1d5db';
    ctx.fillRect(o.x, o.y, o.width, o.height);
    ctx.strokeStyle = '#9ca3af';
    ctx.lineWidth = 1 / scale;
    ctx.strokeRect(o.x, o.y, o.width, o.height);
    ctx.restore();
  }

  // ストローク
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const stroke of strokes) {
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width;
    ctx.stroke(new Path2D(stroke.path));
  }

  ctx.restore();

  // 同期的に toBlob 相当を行う（toDataURL 経由）
  const dataUrl = canvas.toDataURL('image/png');
  const bin = atob(dataUrl.split(',')[1]);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: 'image/png' });
}
