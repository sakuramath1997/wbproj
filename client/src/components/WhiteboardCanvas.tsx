/**
 * WhiteboardCanvas.tsx — ホワイトボード描画コンポーネント (L3/L4)
 *
 * Phase 5 でリファクタリング。入力処理・ジェスチャ・純粋ヘルパーを分離。
 *
 * 現在の責務:
 *   - hooks/useCanvasGesture と hooks/useCanvasInput の組み立て
 *   - Canvas2D による描画ループ（requestAnimationFrame）
 *   - 描画ヘルパー関数（Canvas2D API 直接使用 — L3）
 */

import { useRef, useEffect, useCallback } from 'react';
import type { OverlayDisplayState } from '../types/overlay-display';
import type {
  ToolType,
  Point,
  CanvasTransform,
  DrawEvent,
  CursorInfo,
  OverlayState,
  AssetType,
  BackgroundConfig,
  LassoSelection,
} from '../types';
import { useCanvasGesture } from '../hooks/useCanvasGesture';
import { useCanvasInput } from '../hooks/useCanvasInput';
import { getCursorForTool, computeSelectionBBox } from '../core/stroke-renderer';

// ========================================
// 描画ヘルパー（純粋関数 — コンポーネント状態に非依存）
// ========================================

function drawSpinner(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number,
  angle: number, scale: number,
): void {
  ctx.save();
  ctx.strokeStyle = '#60a5fa';
  ctx.lineWidth = Math.max(2 / scale, 1);
  ctx.lineCap = 'round';
  ctx.globalAlpha = 0.2;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 0.8;
  ctx.beginPath();
  ctx.arc(cx, cy, r, angle, angle + Math.PI * 1.2);
  ctx.stroke();
  ctx.restore();
}

function drawLoadingOverlay(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  scale: number,
  hasExistingImage: boolean,
): void {
  const angle = (Date.now() / 600) * Math.PI * 2;
  const r = Math.min(12, Math.min(w, h) * 0.12) / scale;

  if (hasExistingImage) {
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.fillRect(x, y, w, h);
    const cx = x + w - r * 1.8;
    const cy = y + h - r * 1.8;
    drawSpinner(ctx, cx, cy, r, angle, scale);
  } else {
    const cx = x + w / 2;
    const cy = y + h / 2;
    drawSpinner(ctx, cx, cy, r, angle, scale);
  }
}

// ========================================
// Props
// ========================================

interface WhiteboardCanvasProps {
  activeStrokes: DrawEvent[];
  activeOverlays: OverlayState[];
  cursors: Map<string, CursorInfo>;
  tool: ToolType;
  color: string;
  strokeWidth: number;
  sessionId: string;
  selectedOverlayId: string | null;
  overlayDisplayStates: Map<string, OverlayDisplayState>;
  overlayAssetTypes: Map<string, AssetType>;
  overlayOpacityOverrides?: Map<string, number>;
  overlayLockAspectRatios?: Map<string, boolean>;
  backgroundConfig?: BackgroundConfig;
  canvasSize?: { width: number; height: number };
  onAddDrawEvent: (event: DrawEvent) => void;
  onEraseStrokes: (targetStrokes: DrawEvent[]) => void;
  onRemoveOverlay: (overlayId: string) => void;
  onTransformOverlay: (
    overlayId: string,
    before: { x: number; y: number; width: number; height: number; rotation: number },
    after: { x: number; y: number; width: number; height: number; rotation: number },
  ) => void;
  onSelectOverlay: (overlayId: string | null) => void;
  onDoubleClickOverlay?: (overlayId: string) => void;
  onUpdateCursor: (x: number, y: number) => void;
  onHideCursor: () => void;
  onTransformChange?: (transform: CanvasTransform) => void;
  onLassoSelectionChange?: (selection: LassoSelection | null) => void;
  onLassoMove?: (
    originalStrokes: DrawEvent[], movedStrokes: DrawEvent[],
    overlayDeltas: Array<{ overlayId: string; dx: number; dy: number }>,
  ) => void;
  onLassoDelete?: (strokes: DrawEvent[], overlayIds: string[]) => void;
  externalLassoSelection?: LassoSelection | null;
}

// ========================================
// コンポーネント
// ========================================

export function WhiteboardCanvas({
  activeStrokes,
  activeOverlays,
  cursors,
  tool,
  color,
  strokeWidth,
  sessionId,
  selectedOverlayId,
  overlayDisplayStates,
  overlayAssetTypes,
  overlayOpacityOverrides,
  overlayLockAspectRatios,
  backgroundConfig,
  canvasSize,
  onAddDrawEvent,
  onEraseStrokes,
  onRemoveOverlay,
  onTransformOverlay,
  onSelectOverlay,
  onDoubleClickOverlay,
  onUpdateCursor,
  onHideCursor,
  onTransformChange,
  onLassoSelectionChange,
  onLassoMove,
  onLassoDelete,
  externalLassoSelection,
}: WhiteboardCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // ========================================
  // ジェスチャ (パン/ズーム/ピンチ)
  // ========================================
  const gesture = useCanvasGesture({
    containerRef,
    canvasRef,
    onTransformChange,
  });

  // ========================================
  // 入力処理 (ツール別)
  // ========================================
  const input = useCanvasInput({
    canvasRef,
    containerRef,
    tool, color, strokeWidth, sessionId,
    selectedOverlayId,
    activeStrokes, activeOverlays,
    overlayLockAspectRatios,
    transform: gesture.transform,
    setTransform: gesture.setTransform,
    screenToCanvas: gesture.screenToCanvas,
    isPanningRef: gesture.isPanningRef,
    lastPanPointRef: gesture.lastPanPointRef,
    pointersRef: gesture.pointersRef,
    lastPinchDistRef: gesture.lastPinchDistRef,
    startPinch: gesture.startPinch,
    handlePinchUpdate: gesture.handlePinchUpdate,
    onAddDrawEvent, onEraseStrokes, onRemoveOverlay,
    onTransformOverlay, onSelectOverlay, onDoubleClickOverlay,
    onUpdateCursor, onHideCursor,
    onLassoSelectionChange, onLassoMove, onLassoDelete,
    externalLassoSelection,
  });

  const { transform } = gesture;
  const {
    currentStroke, dragPreview,
    lassoPath, lassoSelectedIds, lassoSelectedOverlayIds,
    lassoDragOffset, lassoScalePreview,
  } = input;

  // ========================================
  // 描画ヘルパー（純粋関数 — コンポーネント状態に非依存）
  // ========================================
  // drawSpinner / drawLoadingOverlay は WhiteboardCanvas 外にモジュールレベルで定義

  // ========================================
  // メイン描画関数
  // ========================================
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;

    // クリア
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    if (canvasSize) {
      ctx.fillStyle = '#e5e7eb';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.translate(transform.x, transform.y);
      ctx.scale(transform.scale, transform.scale);

      ctx.shadowColor = 'rgba(0,0,0,0.15)';
      ctx.shadowBlur = 12 / transform.scale;
      ctx.shadowOffsetX = 2 / transform.scale;
      ctx.shadowOffsetY = 2 / transform.scale;
      ctx.fillStyle = backgroundConfig?.color || '#ffffff';
      ctx.fillRect(0, 0, canvasSize.width, canvasSize.height);
      ctx.shadowColor = 'transparent';

      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, canvasSize.width, canvasSize.height);
      ctx.clip();
      drawBackground(ctx, canvas.width / dpr, canvas.height / dpr, transform, backgroundConfig);
      ctx.restore();
      ctx.restore();
    } else {
      ctx.fillStyle = backgroundConfig?.color || '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    // 変換適用
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.scale, transform.scale);

    if (!canvasSize) {
      drawBackground(ctx, canvas.width / dpr, canvas.height / dpr, transform, backgroundConfig);
    }

    // ---- オーバーレイ描画 ----
    for (const overlay of activeOverlays) {
      ctx.save();
      ctx.globalAlpha = overlayOpacityOverrides?.get(overlay.overlayId) ?? overlay.opacity;

      const isBeingDragged = selectedOverlayId === overlay.overlayId && dragPreview;
      const isLassoDragged = lassoSelectedOverlayIds.has(overlay.overlayId) && lassoDragOffset;
      let displayX = isBeingDragged ? dragPreview.x : overlay.x;
      let displayY = isBeingDragged ? dragPreview.y : overlay.y;
      if (isLassoDragged) {
        displayX += lassoDragOffset.x;
        displayY += lassoDragOffset.y;
        ctx.globalAlpha *= 0.7;
      }
      const displayWidth = isBeingDragged ? dragPreview.width : overlay.width;
      const displayHeight = isBeingDragged ? dragPreview.height : overlay.height;

      if (overlay.rotation !== 0) {
        const centerX = displayX + displayWidth / 2;
        const centerY = displayY + displayHeight / 2;
        ctx.translate(centerX, centerY);
        ctx.rotate((overlay.rotation * Math.PI) / 180);
        ctx.translate(-centerX, -centerY);
      }

      const displayState = overlayDisplayStates.get(overlay.overlayId);
      const img = displayState?.image;
      const status = displayState?.status ?? 'loading';

      if (img && img.complete && (status === 'ready' || status === 'loading')) {
        const assetType = overlayAssetTypes.get(overlay.overlayId) ?? 'image';
        if (assetType !== 'board' && overlay.viewport.width > 0 && overlay.viewport.height > 0) {
          ctx.drawImage(img, overlay.viewport.x, overlay.viewport.y, overlay.viewport.width, overlay.viewport.height, displayX, displayY, displayWidth, displayHeight);
        } else {
          ctx.drawImage(img, displayX, displayY, displayWidth, displayHeight);
        }
        if (status === 'loading') {
          drawLoadingOverlay(ctx, displayX, displayY, displayWidth, displayHeight, transform.scale, true);
        }
      } else if (status === 'transferring') {
        drawTransferringOverlay(ctx, displayState, displayX, displayY, displayWidth, displayHeight, transform.scale);
      } else if (status === 'error') {
        drawErrorOverlay(ctx, displayState, displayX, displayY, displayWidth, displayHeight, transform.scale);
      } else {
        ctx.fillStyle = '#e5e7eb';
        ctx.fillRect(displayX, displayY, displayWidth, displayHeight);
        ctx.strokeStyle = '#9ca3af';
        ctx.lineWidth = 1 / transform.scale;
        ctx.strokeRect(displayX, displayY, displayWidth, displayHeight);
        drawLoadingOverlay(ctx, displayX, displayY, displayWidth, displayHeight, transform.scale, false);
      }

      // 選択枠 + ハンドル
      if (selectedOverlayId === overlay.overlayId) {
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 2 / transform.scale;
        ctx.setLineDash([5 / transform.scale, 5 / transform.scale]);
        ctx.strokeRect(displayX, displayY, displayWidth, displayHeight);
        ctx.setLineDash([]);

        const hs = 4 / transform.scale;
        const hmx = displayX + displayWidth / 2;
        const hmy = displayY + displayHeight / 2;
        drawResizeHandles(ctx, transform.scale, hs, displayX, displayY, displayX + displayWidth, displayY + displayHeight, hmx, hmy);
      }

      ctx.restore();
    }

    // ---- 確定済みストローク ----
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const stroke of activeStrokes) {
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.width;
      ctx.stroke(new Path2D(stroke.path));
    }

    // ---- 描画中ストローク ----
    if (currentStroke && currentStroke.points.length > 1) {
      ctx.strokeStyle = currentStroke.color;
      ctx.lineWidth = currentStroke.width;
      ctx.beginPath();
      ctx.moveTo(currentStroke.points[0].x, currentStroke.points[0].y);
      for (let i = 1; i < currentStroke.points.length; i++) {
        ctx.lineTo(currentStroke.points[i].x, currentStroke.points[i].y);
      }
      ctx.stroke();
    }

    // ---- 投げ縄選択ハイライト ----
    if (lassoSelectedIds.size > 0 || lassoSelectedOverlayIds.size > 0) {
      drawLassoSelection(ctx, transform, activeStrokes, activeOverlays, lassoSelectedIds, lassoSelectedOverlayIds, lassoDragOffset, lassoScalePreview);
    }

    // ---- 投げ縄パス描画中 ----
    if (lassoPath.length > 1) {
      ctx.save();
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 1.5 / transform.scale;
      ctx.setLineDash([5 / transform.scale, 5 / transform.scale]);
      ctx.fillStyle = 'rgba(59, 130, 246, 0.08)';
      ctx.beginPath();
      ctx.moveTo(lassoPath[0].x, lassoPath[0].y);
      for (let i = 1; i < lassoPath.length; i++) {
        ctx.lineTo(lassoPath[i].x, lassoPath[i].y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // ---- 固定サイズキャンバス枠線 ----
    if (canvasSize) {
      ctx.strokeStyle = '#9ca3af';
      ctx.lineWidth = 1 / transform.scale;
      ctx.setLineDash([]);
      ctx.strokeRect(0, 0, canvasSize.width, canvasSize.height);
    }

    ctx.restore();

    // ---- リモートカーソル ----
    ctx.save();
    ctx.scale(dpr, dpr);
    for (const cursor of cursors.values()) {
      const screenX = cursor.x * transform.scale + transform.x;
      const screenY = cursor.y * transform.scale + transform.y;

      ctx.fillStyle = cursor.color;
      ctx.beginPath();
      ctx.moveTo(screenX, screenY);
      ctx.lineTo(screenX + 12, screenY + 10);
      ctx.lineTo(screenX + 6, screenY + 10);
      ctx.lineTo(screenX + 6, screenY + 16);
      ctx.lineTo(screenX, screenY + 12);
      ctx.closePath();
      ctx.fill();

      ctx.font = '12px system-ui, sans-serif';
      ctx.fillStyle = cursor.color;
      ctx.fillText(cursor.name, screenX + 14, screenY + 14);
    }
    ctx.restore();
  }, [
    activeStrokes, activeOverlays, overlayDisplayStates, overlayAssetTypes,
    overlayOpacityOverrides, selectedOverlayId, dragPreview, currentStroke,
    transform, cursors, canvasSize,
    backgroundConfig, lassoPath, lassoSelectedIds, lassoSelectedOverlayIds,
    lassoDragOffset, lassoScalePreview,
  ]);

  // ---- 描画ループ ----
  useEffect(() => {
    let animationId: number;
    const loop = () => {
      render();
      animationId = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(animationId);
  }, [render]);

  // ========================================
  // JSX
  // ========================================
  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        cursor: getCursorForTool(tool),
        touchAction: 'none',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ position: 'absolute', top: 0, left: 0, touchAction: 'none' }}
        onPointerDown={input.handlePointerDown}
        onPointerMove={input.handlePointerMove}
        onPointerUp={input.handlePointerUp}
        onPointerLeave={input.handlePointerLeave}
        onDoubleClick={input.handleDoubleClick}
      />
    </div>
  );
}

// ========================================
// 描画ヘルパー関数（Canvas2D 固有 — L3）
// ========================================

/** 転送中オーバーレイの描画 */
function drawTransferringOverlay(
  ctx: CanvasRenderingContext2D,
  displayState: OverlayDisplayState | undefined,
  x: number, y: number, w: number, h: number,
  scale: number,
): void {
  ctx.fillStyle = '#eff6ff';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#60a5fa';
  ctx.lineWidth = 1 / scale;
  ctx.strokeRect(x, y, w, h);

  const barH = Math.max(4 / scale, 2);
  const barY = y + h / 2 - barH / 2;
  const progress = displayState?.progress ?? 0;
  ctx.fillStyle = '#dbeafe';
  ctx.fillRect(x + 4 / scale, barY, w - 8 / scale, barH);
  ctx.fillStyle = '#3b82f6';
  ctx.fillRect(x + 4 / scale, barY, (w - 8 / scale) * progress, barH);

  const fontSize = Math.max(Math.min(w * 0.08, 12 / scale), 8 / scale);
  ctx.font = `${fontSize}px sans-serif`;
  ctx.fillStyle = '#2563eb';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${Math.round(progress * 100)}%`, x + w / 2, barY - 2 / scale);
  ctx.textBaseline = 'top';
  ctx.fillText('取得中…', x + w / 2, barY + barH + 2 / scale);
}

/** エラーオーバーレイの描画 */
function drawErrorOverlay(
  ctx: CanvasRenderingContext2D,
  displayState: OverlayDisplayState | undefined,
  x: number, y: number, w: number, h: number,
  scale: number,
): void {
  ctx.fillStyle = '#fef2f2';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#f87171';
  ctx.lineWidth = 1 / scale;
  ctx.strokeRect(x, y, w, h);

  const fontSize = Math.max(Math.min(w * 0.08, 14 / scale), 8 / scale);
  ctx.font = `${fontSize}px sans-serif`;
  ctx.fillStyle = '#dc2626';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const msg = displayState?.errorReason === 'decodeFailed' ? 'Decode failed'
    : displayState?.errorReason === 'peerDisconnected' ? 'Peer disconnected'
    : 'Asset not found';
  ctx.fillText(msg, x + w / 2, y + h / 2);
}

/** 投げ縄選択ハイライト + BBox + ハンドル描画 */
function drawLassoSelection(
  ctx: CanvasRenderingContext2D,
  transform: CanvasTransform,
  activeStrokes: DrawEvent[],
  activeOverlays: OverlayState[],
  lassoSelectedIds: Set<string>,
  lassoSelectedOverlayIds: Set<string>,
  lassoDragOffset: Point | null,
  lassoScalePreview: { sx: number; sy: number; ox: number; oy: number } | null,
): void {
  const dx = lassoDragOffset?.x ?? 0;
  const dy = lassoDragOffset?.y ?? 0;
  const sp = lassoScalePreview;
  const isTransforming = (dx !== 0 || dy !== 0 || sp !== null);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const selStrokes = activeStrokes.filter(s => lassoSelectedIds.has(s.id));
  const selOverlays = activeOverlays.filter(o => lassoSelectedOverlayIds.has(o.overlayId));
  const bboxResult = computeSelectionBBox(selStrokes, selOverlays);

  // 選択オーバーレイのハイライト
  for (const overlay of activeOverlays) {
    if (!lassoSelectedOverlayIds.has(overlay.overlayId)) continue;
    ctx.save();
    ctx.globalAlpha = isTransforming ? 0.6 : 1;
    ctx.strokeStyle = 'rgba(59, 130, 246, 0.5)';
    ctx.lineWidth = 2 / transform.scale;
    ctx.strokeRect(overlay.x + dx, overlay.y + dy, overlay.width, overlay.height);
    ctx.restore();
  }

  // 選択ストロークの描画
  for (const stroke of activeStrokes) {
    if (!lassoSelectedIds.has(stroke.id)) continue;
    ctx.save();
    ctx.globalAlpha = isTransforming ? 0.6 : 1;
    if (sp) {
      ctx.translate(sp.ox, sp.oy);
      ctx.scale(sp.sx, sp.sy);
      ctx.translate(-sp.ox, -sp.oy);
      ctx.lineWidth = stroke.width * Math.min(sp.sx, sp.sy);
    } else {
      if (dx !== 0 || dy !== 0) ctx.translate(dx, dy);
      ctx.lineWidth = stroke.width;
    }
    ctx.strokeStyle = stroke.color;
    ctx.stroke(new Path2D(stroke.path));
    ctx.strokeStyle = 'rgba(59, 130, 246, 0.4)';
    ctx.lineWidth = (sp ? stroke.width * Math.min(sp.sx, sp.sy) : stroke.width) + 4 / transform.scale;
    ctx.stroke(new Path2D(stroke.path));
    ctx.restore();
  }

  // BBox + ハンドル
  if (bboxResult) {
    const [bMinX, bMinY, bMaxX, bMaxY] = bboxResult;
    const pad = 6 / transform.scale;

    let dbx0: number, dby0: number, dbx1: number, dby1: number;
    if (sp) {
      dbx0 = sp.ox + (bMinX - sp.ox) * sp.sx;
      dby0 = sp.oy + (bMinY - sp.oy) * sp.sy;
      dbx1 = sp.ox + (bMaxX - sp.ox) * sp.sx;
      dby1 = sp.oy + (bMaxY - sp.oy) * sp.sy;
    } else {
      dbx0 = bMinX + dx; dby0 = bMinY + dy;
      dbx1 = bMaxX + dx; dby1 = bMaxY + dy;
    }
    const rx = dbx0 - pad, ry = dby0 - pad;
    const rw = dbx1 - dbx0 + pad * 2, rh = dby1 - dby0 + pad * 2;

    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 1.5 / transform.scale;
    ctx.setLineDash([6 / transform.scale, 4 / transform.scale]);
    ctx.strokeRect(rx, ry, rw, rh);
    ctx.setLineDash([]);

    const hs = 4 / transform.scale;
    const midX = rx + rw / 2, midY = ry + rh / 2;
    drawResizeHandles(ctx, transform.scale, hs, rx, ry, rx + rw, ry + rh, midX, midY);
  }
  ctx.restore();
}

/** 8 つのリサイズハンドルを描画する */
function drawResizeHandles(
  ctx: CanvasRenderingContext2D,
  scale: number,
  hs: number,
  x0: number, y0: number, x1: number, y1: number,
  midX: number, midY: number,
): void {
  const blue = '#3b82f6';
  const corners = [
    { x: x0, y: y0 }, { x: x1, y: y0 },
    { x: x1, y: y1 }, { x: x0, y: y1 },
  ];
  ctx.fillStyle = blue;
  for (const c of corners) {
    ctx.fillRect(c.x - hs, c.y - hs, hs * 2, hs * 2);
  }

  const thin = 2 / scale;
  const long = 8 / scale;
  ctx.fillStyle = blue;
  ctx.fillRect(midX - long, y0 - thin, long * 2, thin * 2);
  ctx.fillRect(midX - long, y1 - thin, long * 2, thin * 2);
  ctx.fillRect(x0 - thin, midY - long, thin * 2, long * 2);
  ctx.fillRect(x1 - thin, midY - long, thin * 2, long * 2);
}

/** 背景パターンを描画する */
function drawBackground(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  transform: CanvasTransform,
  config?: BackgroundConfig,
): void {
  const pattern = config?.pattern || 'none';
  if (pattern === 'none') return;

  const gridSize = config?.patternSize || 20;
  const patternColor = config?.patternColor || '#e0e0e0';

  const startX = Math.floor(-transform.x / transform.scale / gridSize) * gridSize;
  const startY = Math.floor(-transform.y / transform.scale / gridSize) * gridSize;
  const endX = startX + width / transform.scale + gridSize * 2;
  const endY = startY + height / transform.scale + gridSize * 2;

  ctx.strokeStyle = patternColor;
  ctx.fillStyle = patternColor;

  switch (pattern) {
    case 'grid': {
      ctx.lineWidth = 1 / transform.scale;
      ctx.beginPath();
      for (let x = startX; x < endX; x += gridSize) {
        ctx.moveTo(x, startY);
        ctx.lineTo(x, endY);
      }
      for (let y = startY; y < endY; y += gridSize) {
        ctx.moveTo(startX, y);
        ctx.lineTo(endX, y);
      }
      ctx.stroke();
      break;
    }
    case 'dots': {
      const radius = Math.max(1 / transform.scale, 0.8);
      for (let x = startX; x < endX; x += gridSize) {
        for (let y = startY; y < endY; y += gridSize) {
          ctx.beginPath();
          ctx.arc(x, y, radius, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      break;
    }
    case 'lines': {
      ctx.lineWidth = 1 / transform.scale;
      ctx.beginPath();
      for (let y = startY; y < endY; y += gridSize) {
        ctx.moveTo(startX, y);
        ctx.lineTo(endX, y);
      }
      ctx.stroke();
      break;
    }
  }
}
