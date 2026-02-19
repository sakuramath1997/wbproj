/**
 * ボードエクスポート - PNG / SVG
 * 
 * ストロークとオーバーレイをオフスクリーン Canvas (PNG) または
 * SVG XML 文字列にレンダリングしてエクスポートする。
 */

import type { DrawEvent, OverlayState, BackgroundConfig } from '../types';

/** エクスポート設定 */
export interface ExportOptions {
  /** DPR 倍率（デフォルト: 2） */
  dpr?: number;
  /** エクスポート範囲。省略時は全コンテンツを含む BBox */
  range?: { minX: number; minY: number; maxX: number; maxY: number };
  /** マージン（px、デフォルト: 40） */
  margin?: number;
  /** 背景設定 */
  background?: BackgroundConfig;
  /** 固定キャンバスサイズ（設定時はこの範囲をエクスポート） */
  canvasSize?: { width: number; height: number };
  /** 背景を含めるか（デフォルト: true） */
  includeBackground?: boolean;
}

// ========================================
// BBox 計算
// ========================================

function computeContentBbox(
  strokes: DrawEvent[],
  overlays: OverlayState[]
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const s of strokes) {
    if (s.bbox) {
      const hw = s.width / 2;
      minX = Math.min(minX, s.bbox[0] - hw);
      minY = Math.min(minY, s.bbox[1] - hw);
      maxX = Math.max(maxX, s.bbox[2] + hw);
      maxY = Math.max(maxY, s.bbox[3] + hw);
    }
  }
  for (const o of overlays) {
    minX = Math.min(minX, o.x);
    minY = Math.min(minY, o.y);
    maxX = Math.max(maxX, o.x + o.width);
    maxY = Math.max(maxY, o.y + o.height);
  }

  if (minX === Infinity) return null;
  return { minX, minY, maxX, maxY };
}

function getExportBbox(
  strokes: DrawEvent[],
  overlays: OverlayState[],
  opts: ExportOptions
): { minX: number; minY: number; maxX: number; maxY: number } {
  if (opts.canvasSize) {
    return { minX: 0, minY: 0, maxX: opts.canvasSize.width, maxY: opts.canvasSize.height };
  }
  if (opts.range) {
    return opts.range;
  }
  const margin = opts.margin ?? 40;
  const bbox = computeContentBbox(strokes, overlays);
  if (!bbox) return { minX: -200, minY: -150, maxX: 200, maxY: 150 };
  return {
    minX: bbox.minX - margin,
    minY: bbox.minY - margin,
    maxX: bbox.maxX + margin,
    maxY: bbox.maxY + margin,
  };
}

// ========================================
// PNG エクスポート
// ========================================

/**
 * ボードを PNG Blob としてエクスポートする
 */
export function exportAsPng(
  strokes: DrawEvent[],
  overlays: OverlayState[],
  overlayImages: Map<string, HTMLImageElement>,
  opts: ExportOptions = {}
): Blob | null {
  const dpr = opts.dpr ?? 2;
  const bbox = getExportBbox(strokes, overlays, opts);
  const contentW = bbox.maxX - bbox.minX;
  const contentH = bbox.maxY - bbox.minY;

  if (contentW <= 0 || contentH <= 0) return null;

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(contentW * dpr);
  canvas.height = Math.round(contentH * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.scale(dpr, dpr);

  // 背景
  const bg = opts.background;
  const includeBg = opts.includeBackground !== false;
  if (includeBg) {
    ctx.fillStyle = bg?.color || '#ffffff';
    ctx.fillRect(0, 0, contentW, contentH);
  }

  ctx.save();
  ctx.translate(-bbox.minX, -bbox.minY);

  // 背景パターン
  if (includeBg && bg && bg.pattern !== 'none') {
    drawBgPattern(ctx, bg, bbox);
  }

  // オーバーレイ
  renderOverlays(ctx, overlays, overlayImages);

  // ストローク
  renderStrokes(ctx, strokes);

  ctx.restore();

  // Blob に変換
  const dataUrl = canvas.toDataURL('image/png');
  const bin = atob(dataUrl.split(',')[1]);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: 'image/png' });
}

// ========================================
// SVG エクスポート
// ========================================

/**
 * ボードを SVG 文字列としてエクスポートする
 */
export function exportAsSvg(
  strokes: DrawEvent[],
  overlays: OverlayState[],
  overlayImages: Map<string, HTMLImageElement>,
  opts: ExportOptions = {}
): string {
  const bbox = getExportBbox(strokes, overlays, opts);
  const w = bbox.maxX - bbox.minX;
  const h = bbox.maxY - bbox.minY;

  const bg = opts.background;
  const includeBg = opts.includeBackground !== false;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `viewBox="${bbox.minX} ${bbox.minY} ${w} ${h}" ` +
    `width="${w}" height="${h}">`
  );

  // 背景矩形
  if (includeBg) {
    parts.push(`<rect x="${bbox.minX}" y="${bbox.minY}" width="${w}" height="${h}" fill="${bg?.color || '#ffffff'}"/>`);

    // 背景パターン（SVG の pattern 定義）
    if (bg && bg.pattern !== 'none') {
      parts.push(svgBgPattern(bg, bbox));
    }
  }

  // オーバーレイ
  for (const o of overlays) {
    const img = overlayImages.get(o.overlayId);
    if (img) {
      // Base64 画像を埋め込み
      const dataUrl = imageToDataUrl(img);
      if (dataUrl) {
        parts.push(
          `<image x="${o.x}" y="${o.y}" width="${o.width}" height="${o.height}" ` +
          `opacity="${o.opacity}" ` +
          (o.rotation ? `transform="rotate(${o.rotation} ${o.x + o.width / 2} ${o.y + o.height / 2})" ` : '') +
          `href="${escapeXml(dataUrl)}"/>`
        );
      }
    } else {
      // プレースホルダー矩形
      parts.push(
        `<rect x="${o.x}" y="${o.y}" width="${o.width}" height="${o.height}" ` +
        `fill="#d1d5db" stroke="#9ca3af" stroke-width="1" opacity="${o.opacity}"/>`
      );
    }
  }

  // ストローク
  for (const stroke of strokes) {
    parts.push(
      `<path d="${escapeXml(stroke.path)}" ` +
      `stroke="${stroke.color}" stroke-width="${stroke.width}" ` +
      `fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
    );
  }

  parts.push('</svg>');
  return parts.join('\n');
}

// ========================================
// 描画ヘルパー
// ========================================

function renderStrokes(ctx: CanvasRenderingContext2D, strokes: DrawEvent[]): void {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const stroke of strokes) {
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width;
    ctx.stroke(new Path2D(stroke.path));
  }
}

function renderOverlays(
  ctx: CanvasRenderingContext2D,
  overlays: OverlayState[],
  overlayImages: Map<string, HTMLImageElement>
): void {
  const sorted = [...overlays].sort((a, b) => a.zIndex - b.zIndex);
  for (const o of sorted) {
    ctx.save();
    ctx.globalAlpha = o.opacity;
    if (o.rotation) {
      const cx = o.x + o.width / 2;
      const cy = o.y + o.height / 2;
      ctx.translate(cx, cy);
      ctx.rotate((o.rotation * Math.PI) / 180);
      ctx.translate(-cx, -cy);
    }

    const img = overlayImages.get(o.overlayId);
    if (img) {
      ctx.drawImage(img, o.x, o.y, o.width, o.height);
    } else {
      ctx.fillStyle = '#d1d5db';
      ctx.fillRect(o.x, o.y, o.width, o.height);
      ctx.strokeStyle = '#9ca3af';
      ctx.lineWidth = 1;
      ctx.strokeRect(o.x, o.y, o.width, o.height);
    }
    ctx.restore();
  }
}

function drawBgPattern(
  ctx: CanvasRenderingContext2D,
  bg: BackgroundConfig,
  bbox: { minX: number; minY: number; maxX: number; maxY: number }
): void {
  const gridSize = bg.patternSize || 20;
  ctx.strokeStyle = bg.patternColor || '#e0e0e0';
  ctx.fillStyle = bg.patternColor || '#e0e0e0';

  const gx0 = Math.floor(bbox.minX / gridSize) * gridSize;
  const gy0 = Math.floor(bbox.minY / gridSize) * gridSize;

  if (bg.pattern === 'grid' || bg.pattern === 'lines') {
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (let y = gy0; y <= bbox.maxY; y += gridSize) {
      ctx.moveTo(bbox.minX, y);
      ctx.lineTo(bbox.maxX, y);
    }
    if (bg.pattern === 'grid') {
      for (let x = gx0; x <= bbox.maxX; x += gridSize) {
        ctx.moveTo(x, bbox.minY);
        ctx.lineTo(x, bbox.maxY);
      }
    }
    ctx.stroke();
  }

  if (bg.pattern === 'dots') {
    for (let x = gx0; x <= bbox.maxX; x += gridSize) {
      for (let y = gy0; y <= bbox.maxY; y += gridSize) {
        ctx.beginPath();
        ctx.arc(x, y, 0.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

function svgBgPattern(
  bg: BackgroundConfig,
  bbox: { minX: number; minY: number; maxX: number; maxY: number }
): string {
  const s = bg.patternSize || 20;
  const c = bg.patternColor || '#e0e0e0';
  const parts: string[] = [];

  const gx0 = Math.floor(bbox.minX / s) * s;
  const gy0 = Math.floor(bbox.minY / s) * s;

  parts.push('<g>');
  if (bg.pattern === 'grid' || bg.pattern === 'lines') {
    for (let y = gy0; y <= bbox.maxY; y += s) {
      parts.push(`<line x1="${bbox.minX}" y1="${y}" x2="${bbox.maxX}" y2="${y}" stroke="${c}" stroke-width="0.5"/>`);
    }
    if (bg.pattern === 'grid') {
      for (let x = gx0; x <= bbox.maxX; x += s) {
        parts.push(`<line x1="${x}" y1="${bbox.minY}" x2="${x}" y2="${bbox.maxY}" stroke="${c}" stroke-width="0.5"/>`);
      }
    }
  }
  if (bg.pattern === 'dots') {
    for (let x = gx0; x <= bbox.maxX; x += s) {
      for (let y = gy0; y <= bbox.maxY; y += s) {
        parts.push(`<circle cx="${x}" cy="${y}" r="0.8" fill="${c}"/>`);
      }
    }
  }
  parts.push('</g>');
  return parts.join('\n');
}

/** HTMLImageElement を data URL に変換 */
function imageToDataUrl(img: HTMLImageElement): string | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ========================================
// ダウンロードヘルパー
// ========================================

/** Blob をファイルとしてダウンロード */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** 文字列をファイルとしてダウンロード */
export function downloadString(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  downloadBlob(blob, filename);
}
