/**
 * hooks/useCanvasGesture.ts — パン・ズーム・ピンチ ジェスチャ管理 (L3 Shell)
 *
 * Phase 5 で WhiteboardCanvas.tsx から分離。
 *
 * 責務:
 *   - transform (x, y, scale) の React 状態管理
 *   - スクリーン座標 → キャンバス座標変換
 *   - ピンチ（2本指）ズーム + パン
 *   - ホイールズーム
 *   - パンツール操作
 *   - onTransformChange コールバック通知
 */

import { useState, useCallback, useRef, useEffect, type RefObject, type MutableRefObject } from 'react';
import type { CanvasTransform, Point } from '../types';
import {
  computePinchZoom,
  computeWheelZoom,
  screenToCanvasCoord,
} from '../core/stroke-renderer';

// ========================================
// フックオプション
// ========================================

export interface UseCanvasGestureOptions {
  /** コンテナ要素の ref */
  containerRef: RefObject<HTMLDivElement | null>;
  /** キャンバス要素の ref */
  canvasRef: RefObject<HTMLCanvasElement | null>;
  /** transform 変化通知コールバック */
  onTransformChange?: (transform: CanvasTransform) => void;
}

// ========================================
// フック戻り値
// ========================================

export interface UseCanvasGestureReturn {
  /** 現在の transform */
  transform: CanvasTransform;
  /** transform を直接更新（入力フックからパン操作等で使用） */
  setTransform: React.Dispatch<React.SetStateAction<CanvasTransform>>;
  /** スクリーン座標 → キャンバス座標変換 */
  screenToCanvas: (screenX: number, screenY: number) => Point;

  // ---- ピンチ/パン状態（入力フックから参照・更新） ----
  /** パン中フラグ */
  isPanningRef: MutableRefObject<boolean>;
  /** 最後のパンポイント（スクリーン座標） */
  lastPanPointRef: MutableRefObject<Point | null>;
  /** アクティブポインタ追跡 */
  pointersRef: MutableRefObject<Map<number, { x: number; y: number }>>;
  /** 最後のピンチ距離 */
  lastPinchDistRef: MutableRefObject<number | null>;

  /**
   * 2本指ピンチ/パンの更新処理。
   * handlePointerMove 内で pointersRef.size === 2 のとき呼び出す。
   * @returns true ならピンチ処理済み（後続のツール処理をスキップ）
   */
  handlePinchUpdate: () => boolean;

  /**
   * ピンチ開始判定。handlePointerDown 内で pointersRef.size === 2 のとき呼び出す。
   */
  startPinch: () => void;

  /**
   * ホイールズームハンドラ。useEffect で native listener として登録する。
   */
  handleWheel: (e: WheelEvent) => void;
}

// ========================================
// フック実装
// ========================================

export function useCanvasGesture({
  containerRef,
  canvasRef,
  onTransformChange,
}: UseCanvasGestureOptions): UseCanvasGestureReturn {
  const [transform, setTransform] = useState<CanvasTransform>({ x: 0, y: 0, scale: 1 });

  // ---- パン/ピンチ ref ----
  const isPanningRef = useRef(false);
  const lastPanPointRef = useRef<Point | null>(null);
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const lastPinchDistRef = useRef<number | null>(null);

  // ---- transform 変化通知 ----
  useEffect(() => {
    onTransformChange?.(transform);
  }, [transform, onTransformChange]);

  // ---- キャンバスリサイズ ----
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = container.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
    };

    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [canvasRef, containerRef]);

  // ---- ホイールズーム（native listener で passive: false にする必要あり）----
  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    setTransform(prev => computeWheelZoom(prev, e.deltaY, mouseX, mouseY));
  }, [containerRef]);

  // wheel イベントを non-passive で登録
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [canvasRef, handleWheel]);

  // ---- スクリーン→キャンバス座標変換 ----
  const screenToCanvas = useCallback((screenX: number, screenY: number): Point => {
    const container = containerRef.current;
    if (!container) return { x: screenX, y: screenY };

    const rect = container.getBoundingClientRect();
    return screenToCanvasCoord(screenX, screenY, rect.left, rect.top, transform);
  }, [containerRef, transform]);

  // ---- ピンチ開始 ----
  const startPinch = useCallback(() => {
    const points = Array.from(pointersRef.current.values());
    if (points.length < 2) return;
    const dist = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
    lastPinchDistRef.current = dist;
    lastPanPointRef.current = {
      x: (points[0].x + points[1].x) / 2,
      y: (points[0].y + points[1].y) / 2,
    };
    isPanningRef.current = true;
  }, []);

  // ---- ピンチ更新 ----
  const handlePinchUpdate = useCallback((): boolean => {
    if (pointersRef.current.size !== 2 || lastPinchDistRef.current === null) return false;

    const points = Array.from(pointersRef.current.values());
    const newDist = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
    const center = {
      x: (points[0].x + points[1].x) / 2,
      y: (points[0].y + points[1].y) / 2,
    };

    const scaleFactor = newDist / lastPinchDistRef.current;
    const panDx = lastPanPointRef.current ? center.x - lastPanPointRef.current.x : 0;
    const panDy = lastPanPointRef.current ? center.y - lastPanPointRef.current.y : 0;

    setTransform(prev => computePinchZoom(prev, scaleFactor, center, panDx, panDy));

    lastPinchDistRef.current = newDist;
    lastPanPointRef.current = center;
    return true;
  }, []);

  return {
    transform,
    setTransform,
    screenToCanvas,
    isPanningRef,
    lastPanPointRef,
    pointersRef,
    lastPinchDistRef,
    handlePinchUpdate,
    startPinch,
    handleWheel,
  };
}
