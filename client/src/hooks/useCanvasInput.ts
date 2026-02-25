/**
 * hooks/useCanvasInput.ts — ツール別入力処理 (L4 Shell)
 *
 * Phase 5 で WhiteboardCanvas.tsx から分離。
 *
 * 責務:
 *   - PointerEvent の取得・正規化（architecture-spec §4.7 Web 実装）
 *   - ツール別入力処理（pen / eraser / select / lasso / pan）
 *   - ストローク描画中の状態管理
 *   - オーバーレイドラッグ＆リサイズ
 *   - 投げ縄パス・選択・移動・リサイズ
 *   - Delete/Escape キーボードショートカット
 *   - Shift キー監視
 */

import { useState, useCallback, useRef, useEffect, type RefObject, type MutableRefObject } from 'react';
import type {
  ToolType,
  Point,
  ActiveStroke,
  CanvasTransform,
  DrawEvent,
  OverlayState,
  LassoSelection,
} from '../types';
import {
  calculateBBox,
  generateStrokeId,
  getTimestamp,
  isPointInBBox,
  fitCurveToSvgPath,
  PRESETS,
} from '../utils';
import {
  type ResizeMode,
  pointInPolygon,
  offsetSvgPathCanvas,
  scaleSvgPath,
  isPointInRect,
  hitTestResizeHandles,
  computeResize,
  computeLassoScale,
  computeSelectionBBox,
} from '../core/stroke-renderer';

// ========================================
// フックオプション
// ========================================

export interface UseCanvasInputOptions {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  containerRef: RefObject<HTMLDivElement | null>;

  // ---- 外部状態 ----
  tool: ToolType;
  color: string;
  strokeWidth: number;
  sessionId: string;
  selectedOverlayId: string | null;
  activeStrokes: DrawEvent[];
  activeOverlays: OverlayState[];
  overlayLockAspectRatios?: Map<string, boolean>;

  // ---- ジェスチャフックからの参照 ----
  transform: CanvasTransform;
  setTransform: React.Dispatch<React.SetStateAction<CanvasTransform>>;
  screenToCanvas: (screenX: number, screenY: number) => Point;
  isPanningRef: MutableRefObject<boolean>;
  lastPanPointRef: MutableRefObject<Point | null>;
  pointersRef: MutableRefObject<Map<number, { x: number; y: number }>>;
  lastPinchDistRef: MutableRefObject<number | null>;
  startPinch: () => void;
  handlePinchUpdate: () => boolean;

  // ---- コールバック ----
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
  onLassoSelectionChange?: (selection: LassoSelection | null) => void;
  onLassoMove?: (
    originalStrokes: DrawEvent[], movedStrokes: DrawEvent[],
    overlayDeltas: Array<{ overlayId: string; dx: number; dy: number }>,
  ) => void;
  onLassoDelete?: (strokes: DrawEvent[], overlayIds: string[]) => void;
  externalLassoSelection?: LassoSelection | null;
}

// ========================================
// フック戻り値
// ========================================

export interface UseCanvasInputReturn {
  /** 描画中のストローク（プレビュー用） */
  currentStroke: ActiveStroke | null;
  /** オーバーレイドラッグ中のプレビュー */
  dragPreview: { x: number; y: number; width: number; height: number } | null;

  // ---- 投げ縄状態（描画に必要） ----
  lassoPath: Point[];
  lassoSelectedIds: Set<string>;
  lassoSelectedOverlayIds: Set<string>;
  lassoDragOffset: Point | null;
  lassoScalePreview: { sx: number; sy: number; ox: number; oy: number } | null;

  // ---- イベントハンドラ ----
  handlePointerDown: (e: React.PointerEvent) => void;
  handlePointerMove: (e: React.PointerEvent) => void;
  handlePointerUp: (e: React.PointerEvent) => void;
  handlePointerLeave: (e: React.PointerEvent) => void;
  handleDoubleClick: (e: React.MouseEvent) => void;
}

// ========================================
// フック実装
// ========================================

export function useCanvasInput({
  canvasRef,
  tool,
  color,
  strokeWidth,
  sessionId,
  selectedOverlayId,
  activeStrokes,
  activeOverlays,
  overlayLockAspectRatios,
  transform,
  setTransform,
  screenToCanvas,
  isPanningRef,
  lastPanPointRef,
  pointersRef,
  lastPinchDistRef,
  startPinch,
  handlePinchUpdate,
  onAddDrawEvent,
  onEraseStrokes,
  onRemoveOverlay,
  onTransformOverlay,
  onSelectOverlay,
  onDoubleClickOverlay,
  onUpdateCursor,
  onHideCursor,
  onLassoSelectionChange,
  onLassoMove,
  onLassoDelete,
  externalLassoSelection,
}: UseCanvasInputOptions): UseCanvasInputReturn {

  // ---- ストローク描画中 ----
  const activeStrokeRef = useRef<ActiveStroke | null>(null);
  const [currentStroke, setCurrentStroke] = useState<ActiveStroke | null>(null);

  // ---- Shift キー ----
  const [shiftPressed, setShiftPressed] = useState(false);

  // ---- オーバーレイドラッグ ----
  const dragModeRef = useRef<ResizeMode>('none');
  const dragStartRef = useRef<Point | null>(null);
  const dragOverlayInitialRef = useRef<{ x: number; y: number; width: number; height: number; rotation: number } | null>(null);
  const [dragPreview, setDragPreview] = useState<{ x: number; y: number; width: number; height: number } | null>(null);

  // ---- 投げ縄 ----
  const lassoPathRef = useRef<Point[]>([]);
  const [lassoPath, setLassoPath] = useState<Point[]>([]);
  const [lassoSelectedIds, setLassoSelectedIds] = useState<Set<string>>(new Set());
  const [lassoSelectedOverlayIds, setLassoSelectedOverlayIds] = useState<Set<string>>(new Set());
  const lassoDragStartRef = useRef<Point | null>(null);
  const [lassoDragOffset, setLassoDragOffset] = useState<Point | null>(null);
  const lassoResizeModeRef = useRef<ResizeMode>('none');
  const lassoInitialBboxRef = useRef<[number, number, number, number] | null>(null);
  const [lassoScalePreview, setLassoScalePreview] = useState<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  // ---- ツール切替時: 投げ縄状態クリア（React recommended: during render）----
  const [prevTool, setPrevTool] = useState(tool);
  if (tool !== prevTool) {
    setPrevTool(tool);
    if (tool !== 'lasso') {
      setLassoSelectedIds(new Set());
      setLassoSelectedOverlayIds(new Set());
      setLassoPath([]);
      lassoPathRef.current = [];
      lassoDragStartRef.current = null;
      setLassoDragOffset(null);
      lassoResizeModeRef.current = 'none';
      lassoInitialBboxRef.current = null;
      setLassoScalePreview(null);
    }
  }

  // ---- 投げ縄選択状態を親に通知 ----
  useEffect(() => {
    if (lassoSelectedIds.size === 0 && lassoSelectedOverlayIds.size === 0) {
      onLassoSelectionChange?.(null);
    } else {
      onLassoSelectionChange?.({ strokeIds: lassoSelectedIds, overlayIds: lassoSelectedOverlayIds });
    }
  }, [lassoSelectedIds, lassoSelectedOverlayIds, onLassoSelectionChange]);

  // ---- 外部からの投げ縄選択設定（React recommended: during render）----
  const prevExternalSelectionRef = useRef<LassoSelection | null | undefined>(undefined);
  if (externalLassoSelection !== prevExternalSelectionRef.current && externalLassoSelection) {
    setLassoSelectedIds(externalLassoSelection.strokeIds);
    setLassoSelectedOverlayIds(externalLassoSelection.overlayIds);
  }
  prevExternalSelectionRef.current = externalLassoSelection;

  // ---- 選択オーバーレイ変更時: ドラッグ状態リセット（React recommended: during render）----
  const [prevSelectedOverlayId, setPrevSelectedOverlayId] = useState(selectedOverlayId);
  if (selectedOverlayId !== prevSelectedOverlayId) {
    setPrevSelectedOverlayId(selectedOverlayId);
    dragModeRef.current = 'none';
    dragStartRef.current = null;
    dragOverlayInitialRef.current = null;
    setDragPreview(null);
  }

  // ---- Shift キー監視 ----
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift') setShiftPressed(true);
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') setShiftPressed(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  // ---- 消しゴム処理 ----
  const eraseAtPoint = useCallback((point: Point) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const eraserRadius = strokeWidth + 5;
    const strokesToErase: DrawEvent[] = [];

    for (const stroke of activeStrokes) {
      if (!isPointInBBox(point.x, point.y, stroke.bbox, eraserRadius)) continue;

      const path = new Path2D(stroke.path);
      ctx.lineWidth = stroke.width + eraserRadius * 2;
      if (ctx.isPointInStroke(path, point.x, point.y)) {
        strokesToErase.push(stroke);
      }
    }

    if (strokesToErase.length > 0) {
      onEraseStrokes(strokesToErase);
    }
  }, [canvasRef, activeStrokes, strokeWidth, onEraseStrokes]);

  // ---- Delete/Escape キーボード ----
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedOverlayId) {
          onRemoveOverlay(selectedOverlayId);
          onSelectOverlay(null);
        }
        if ((lassoSelectedIds.size > 0 || lassoSelectedOverlayIds.size > 0) && onLassoDelete) {
          const toDeleteStrokes = activeStrokes.filter(s => lassoSelectedIds.has(s.id));
          const toDeleteOverlayIds = Array.from(lassoSelectedOverlayIds);
          if (toDeleteStrokes.length > 0 || toDeleteOverlayIds.length > 0) {
            onLassoDelete(toDeleteStrokes, toDeleteOverlayIds);
            setLassoSelectedIds(new Set());
            setLassoSelectedOverlayIds(new Set());
          }
        }
      }
      if (e.key === 'Escape') {
        onSelectOverlay(null);
        setLassoSelectedIds(new Set());
        setLassoSelectedOverlayIds(new Set());
        setLassoPath([]);
        lassoPathRef.current = [];
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedOverlayId, onRemoveOverlay, onSelectOverlay, lassoSelectedIds, lassoSelectedOverlayIds, activeStrokes, onLassoDelete]);

  // ========================================
  // PointerDown
  // ========================================
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.setPointerCapture(e.pointerId);
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // ドラッグ状態クリア
    dragModeRef.current = 'none';
    dragStartRef.current = null;
    dragOverlayInitialRef.current = null;
    setDragPreview(null);

    // 2 本指 → ピンチ/パン
    if (pointersRef.current.size === 2) {
      startPinch();
      return;
    }

    const point = screenToCanvas(e.clientX, e.clientY);

    // ---- pan ----
    if (tool === 'pan') {
      isPanningRef.current = true;
      lastPanPointRef.current = { x: e.clientX, y: e.clientY };
      return;
    }

    // ---- select ----
    if (tool === 'select') {
      if (selectedOverlayId) {
        const selectedOverlay = activeOverlays.find(o => o.overlayId === selectedOverlayId);
        if (selectedOverlay) {
          const handleSize = 12 / transform.scale;
          // ハンドルヒットテスト
          const hitMode = hitTestResizeHandles(
            point.x, point.y,
            selectedOverlay.x, selectedOverlay.y,
            selectedOverlay.width, selectedOverlay.height,
            handleSize,
          );
          if (hitMode !== 'none') {
            dragModeRef.current = hitMode;
            dragStartRef.current = point;
            dragOverlayInitialRef.current = {
              x: selectedOverlay.x, y: selectedOverlay.y,
              width: selectedOverlay.width, height: selectedOverlay.height,
              rotation: selectedOverlay.rotation,
            };
            return;
          }
          // 内部クリック → 移動
          if (isPointInRect(point.x, point.y, selectedOverlay.x, selectedOverlay.y, selectedOverlay.width, selectedOverlay.height)) {
            dragModeRef.current = 'move';
            dragStartRef.current = point;
            dragOverlayInitialRef.current = {
              x: selectedOverlay.x, y: selectedOverlay.y,
              width: selectedOverlay.width, height: selectedOverlay.height,
              rotation: selectedOverlay.rotation,
            };
            return;
          }
        }
      }
      // オーバーレイをクリック判定（z-index 高い順）
      let foundOverlay: OverlayState | null = null;
      for (let i = activeOverlays.length - 1; i >= 0; i--) {
        const overlay = activeOverlays[i];
        if (isPointInRect(point.x, point.y, overlay.x, overlay.y, overlay.width, overlay.height)) {
          foundOverlay = overlay;
          break;
        }
      }
      onSelectOverlay(foundOverlay?.overlayId ?? null);
      return;
    }

    // ---- pen ----
    if (tool === 'pen') {
      const newStroke: ActiveStroke = {
        id: generateStrokeId(),
        points: [{ ...point, timestamp: Date.now(), pressure: e.pressure }],
        color,
        width: strokeWidth,
      };
      activeStrokeRef.current = newStroke;
      setCurrentStroke(newStroke);
    }

    // ---- eraser ----
    if (tool === 'eraser') {
      eraseAtPoint(point);
    }

    // ---- lasso ----
    if (tool === 'lasso') {
      // 既存選択がある場合
      if (lassoSelectedIds.size > 0 || lassoSelectedOverlayIds.size > 0) {
        const selStrokes = activeStrokes.filter(s => lassoSelectedIds.has(s.id));
        const selOverlays = activeOverlays.filter(o => lassoSelectedOverlayIds.has(o.overlayId));
        const bboxResult = computeSelectionBBox(selStrokes, selOverlays);

        if (bboxResult) {
          const [bMinX, bMinY, bMaxX, bMaxY] = bboxResult;
          const pad = 6 / transform.scale;
          const bx0 = bMinX - pad, by0 = bMinY - pad;
          const bx1 = bMaxX + pad, by1 = bMaxY + pad;
          const handleHit = 12 / transform.scale;

          // 8 ハンドル判定
          const hitMode = hitTestResizeHandles(point.x, point.y, bx0, by0, bx1 - bx0, by1 - by0, handleHit);
          if (hitMode !== 'none') {
            lassoResizeModeRef.current = hitMode;
            lassoDragStartRef.current = point;
            lassoInitialBboxRef.current = [bMinX, bMinY, bMaxX, bMaxY];
            return;
          }

          // bbox 内クリック → 移動
          if (isPointInRect(point.x, point.y, bx0, by0, bx1 - bx0, by1 - by0)) {
            lassoResizeModeRef.current = 'move';
            lassoDragStartRef.current = point;
            lassoInitialBboxRef.current = [bMinX, bMinY, bMaxX, bMaxY];
            return;
          }
        }
        // bbox 外クリック → 選択解除して新規投げ縄
        setLassoSelectedIds(new Set());
        setLassoSelectedOverlayIds(new Set());
        setLassoScalePreview(null);
      }
      // 投げ縄パス描画開始
      lassoPathRef.current = [point];
      setLassoPath([point]);
    }
  }, [
    canvasRef, tool, color, strokeWidth, screenToCanvas, eraseAtPoint,
    activeOverlays, activeStrokes, selectedOverlayId, transform.scale,
    onSelectOverlay, lassoSelectedIds, lassoSelectedOverlayIds,
    pointersRef, isPanningRef, lastPanPointRef, startPinch,
  ]);

  // ========================================
  // PointerMove
  // ========================================
  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (pointersRef.current.has(e.pointerId)) {
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    // ピンチ
    if (pointersRef.current.size === 2 && lastPinchDistRef.current !== null) {
      handlePinchUpdate();
      return;
    }

    const point = screenToCanvas(e.clientX, e.clientY);
    onUpdateCursor(point.x, point.y);

    // ---- pan ----
    if (tool === 'pan' && isPanningRef.current && lastPanPointRef.current) {
      const dx = e.clientX - lastPanPointRef.current.x;
      const dy = e.clientY - lastPanPointRef.current.y;
      setTransform((prev: CanvasTransform) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
      lastPanPointRef.current = { x: e.clientX, y: e.clientY };
      return;
    }

    // ---- select: ドラッグ ----
    if (tool === 'select' && dragModeRef.current !== 'none' && dragStartRef.current && dragOverlayInitialRef.current && selectedOverlayId) {
      const dx = point.x - dragStartRef.current.x;
      const dy = point.y - dragStartRef.current.y;
      const initial = dragOverlayInitialRef.current;

      if (dragModeRef.current === 'move') {
        setDragPreview({ x: initial.x + dx, y: initial.y + dy, width: initial.width, height: initial.height });
      } else {
        const locked = !(overlayLockAspectRatios?.get(selectedOverlayId) === false);
        const lockAR = locked ? !shiftPressed : shiftPressed;
        const result = computeResize(dragModeRef.current, initial, dx, dy, lockAR);
        setDragPreview(result);
      }
      return;
    }

    // ---- pen ----
    if (tool === 'pen' && activeStrokeRef.current) {
      activeStrokeRef.current.points.push({ ...point, timestamp: Date.now(), pressure: e.pressure });
      setCurrentStroke({ ...activeStrokeRef.current });
    }

    // ---- eraser ----
    if (tool === 'eraser' && e.buttons > 0) {
      eraseAtPoint(point);
    }

    // ---- lasso ----
    if (tool === 'lasso') {
      if (lassoDragStartRef.current && e.buttons > 0 && lassoInitialBboxRef.current) {
        const mode = lassoResizeModeRef.current;
        const dx = point.x - lassoDragStartRef.current.x;
        const dy = point.y - lassoDragStartRef.current.y;

        if (mode === 'move') {
          setLassoDragOffset({ x: dx, y: dy });
          setLassoScalePreview(null);
        } else if (mode !== 'none') {
          const [bMinX, bMinY, bMaxX, bMaxY] = lassoInitialBboxRef.current;
          const scaleResult = computeLassoScale(mode, dx, dy, bMinX, bMinY, bMaxX, bMaxY);
          if (scaleResult) {
            setLassoScalePreview(scaleResult);
            setLassoDragOffset(null);
          }
        }
      } else if (lassoPathRef.current.length > 0 && e.buttons > 0) {
        lassoPathRef.current.push(point);
        setLassoPath([...lassoPathRef.current]);
      }
    }
  }, [
    tool, screenToCanvas, eraseAtPoint, onUpdateCursor,
    selectedOverlayId, shiftPressed, overlayLockAspectRatios,
    pointersRef, lastPinchDistRef, handlePinchUpdate,
    isPanningRef, lastPanPointRef, setTransform,
  ]);

  // ========================================
  // PointerUp
  // ========================================
  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const canvas = canvasRef.current;
    if (canvas) canvas.releasePointerCapture(e.pointerId);

    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) lastPinchDistRef.current = null;

    if (isPanningRef.current) {
      isPanningRef.current = false;
      lastPanPointRef.current = null;
      return;
    }

    // ---- select: ドラッグ完了 ----
    if (tool === 'select' && dragModeRef.current !== 'none' && dragOverlayInitialRef.current && selectedOverlayId && dragPreview) {
      const before = dragOverlayInitialRef.current;
      const selectedOverlay = activeOverlays.find(o => o.overlayId === selectedOverlayId);

      if (
        dragPreview.x !== before.x || dragPreview.y !== before.y ||
        dragPreview.width !== before.width || dragPreview.height !== before.height
      ) {
        onTransformOverlay(
          selectedOverlayId,
          { x: before.x, y: before.y, width: before.width, height: before.height, rotation: selectedOverlay?.rotation ?? 0 },
          { x: dragPreview.x, y: dragPreview.y, width: dragPreview.width, height: dragPreview.height, rotation: selectedOverlay?.rotation ?? 0 },
        );
      }

      dragModeRef.current = 'none';
      dragStartRef.current = null;
      dragOverlayInitialRef.current = null;
      setDragPreview(null);
      return;
    }

    // ---- pen: ストローク確定 ----
    if (tool === 'pen' && activeStrokeRef.current) {
      const stroke = activeStrokeRef.current;
      if (stroke.points.length >= 2) {
        const path = fitCurveToSvgPath(stroke.points, PRESETS.freehand);
        const bbox = calculateBBox(stroke.points);
        const event: DrawEvent = {
          type: 'D', timestamp: getTimestamp(), sessionId,
          id: stroke.id, color: stroke.color, width: stroke.width,
          bbox, path,
        };
        onAddDrawEvent(event);
      }
      activeStrokeRef.current = null;
      setCurrentStroke(null);
    }

    // ---- lasso: 移動/リサイズ確定 or 選択判定 ----
    if (tool === 'lasso') {
      const mode = lassoResizeModeRef.current;
      const hasSelection = lassoSelectedIds.size > 0 || lassoSelectedOverlayIds.size > 0;

      if (lassoDragStartRef.current && hasSelection && mode !== 'none') {
        const originals = activeStrokes.filter(s => lassoSelectedIds.has(s.id));

        if (mode === 'move' && lassoDragOffset) {
          const dx = lassoDragOffset.x;
          const dy = lassoDragOffset.y;
          if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
            const moved = originals.map(s => ({
              ...s, id: generateStrokeId(), timestamp: getTimestamp(), sessionId,
              path: offsetSvgPathCanvas(s.path, dx, dy),
              bbox: s.bbox ? [s.bbox[0] + dx, s.bbox[1] + dy, s.bbox[2] + dx, s.bbox[3] + dy] as [number, number, number, number] : s.bbox,
            }));
            const overlayDeltas: Array<{ overlayId: string; dx: number; dy: number }> = [];
            for (const ov of activeOverlays) {
              if (lassoSelectedOverlayIds.has(ov.overlayId)) {
                overlayDeltas.push({ overlayId: ov.overlayId, dx, dy });
              }
            }
            onLassoMove?.(originals, moved, overlayDeltas);
            setLassoSelectedIds(new Set(moved.map(s => s.id)));
          }
        } else if (lassoScalePreview) {
          const { sx, sy, ox, oy } = lassoScalePreview;
          if (Math.abs(sx - 1) > 0.001 || Math.abs(sy - 1) > 0.001) {
            const scaled = originals.map(s => ({
              ...s, id: generateStrokeId(), timestamp: getTimestamp(), sessionId,
              path: scaleSvgPath(s.path, sx, sy, ox, oy),
              width: s.width * Math.min(sx, sy),
              bbox: s.bbox ? [
                ox + (s.bbox[0] - ox) * sx, oy + (s.bbox[1] - oy) * sy,
                ox + (s.bbox[2] - ox) * sx, oy + (s.bbox[3] - oy) * sy,
              ] as [number, number, number, number] : s.bbox,
            }));
            onLassoMove?.(originals, scaled, []);
            setLassoSelectedIds(new Set(scaled.map(s => s.id)));
          }
        }

        lassoResizeModeRef.current = 'none';
        lassoDragStartRef.current = null;
        lassoInitialBboxRef.current = null;
        setLassoDragOffset(null);
        setLassoScalePreview(null);
      } else if (lassoPathRef.current.length >= 3) {
        // 投げ縄パスを閉じて選択判定
        const polygon = lassoPathRef.current;
        const selected = new Set<string>();
        for (const stroke of activeStrokes) {
          if (stroke.bbox) {
            const cx = (stroke.bbox[0] + stroke.bbox[2]) / 2;
            const cy = (stroke.bbox[1] + stroke.bbox[3]) / 2;
            if (pointInPolygon(cx, cy, polygon)) selected.add(stroke.id);
          }
        }
        const selectedOvs = new Set<string>();
        for (const ov of activeOverlays) {
          const cx = ov.x + ov.width / 2;
          const cy = ov.y + ov.height / 2;
          if (pointInPolygon(cx, cy, polygon)) selectedOvs.add(ov.overlayId);
        }
        setLassoSelectedIds(selected);
        setLassoSelectedOverlayIds(selectedOvs);
        lassoPathRef.current = [];
        setLassoPath([]);
      } else {
        lassoPathRef.current = [];
        setLassoPath([]);
      }
    }
  }, [
    canvasRef, tool, sessionId, selectedOverlayId, activeOverlays, activeStrokes,
    dragPreview, onAddDrawEvent, onTransformOverlay,
    lassoSelectedIds, lassoSelectedOverlayIds, lassoDragOffset, lassoScalePreview, onLassoMove,
    pointersRef, lastPinchDistRef, isPanningRef, lastPanPointRef,
  ]);

  // ========================================
  // PointerLeave
  // ========================================
  const handlePointerLeave = useCallback((e: React.PointerEvent) => {
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) lastPinchDistRef.current = null;
    onHideCursor();
  }, [pointersRef, lastPinchDistRef, onHideCursor]);

  // ========================================
  // DoubleClick
  // ========================================
  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    if (!onDoubleClickOverlay) return;
    if (tool !== 'select') return;

    const point = screenToCanvas(e.clientX, e.clientY);
    for (let i = activeOverlays.length - 1; i >= 0; i--) {
      const overlay = activeOverlays[i];
      if (isPointInRect(point.x, point.y, overlay.x, overlay.y, overlay.width, overlay.height)) {
        onDoubleClickOverlay(overlay.overlayId);
        return;
      }
    }
  }, [tool, activeOverlays, screenToCanvas, onDoubleClickOverlay]);

  return {
    currentStroke,
    dragPreview,
    lassoPath,
    lassoSelectedIds,
    lassoSelectedOverlayIds,
    lassoDragOffset,
    lassoScalePreview,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerLeave,
    handleDoubleClick,
  };
}
