/**
 * ViewportEditorImage - 画像のクロップ設定
 *
 * canvas サイズは ResizeObserver で自律管理。
 * コンテンツと canvas サイズの両方が揃ったタイミングで初期フィット。
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { loadAssetFileAsDataUrl } from '../utils/storage';

// ----------------------------------------------------------------
// 型
// ----------------------------------------------------------------

type Viewport = { x: number; y: number; width: number; height: number };
type Transform = { x: number; y: number; scale: number };
type DragMode = 'none' | 'move' | 'resize-nw' | 'resize-ne' | 'resize-se' | 'resize-sw';

interface DragState {
  mode: DragMode;
  startImgX: number;
  startImgY: number;
  startVp: Viewport;
}

export interface ViewportEditorImageProps {
  assetUuid: string;
  viewport: Viewport;
  onViewportChange: (vp: Viewport) => void;
  onAspectRatioDetected?: (ar: number) => void;
}

// ----------------------------------------------------------------
// コンポーネント
// ----------------------------------------------------------------

export function ViewportEditorImage({
  assetUuid,
  viewport,
  onViewportChange,
  onAspectRatioDetected,
}: ViewportEditorImageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // --- コンテンツ ---
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // --- 表示変換 ---
  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, scale: 1 });

  // --- canvas の論理サイズ（ResizeObserver が更新） ---
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

  // --- 初期フィット済みフラグ ---
  const hasInitialFitRef = useRef(false);

  // --- ドラッグ状態（ref で持つのでハンドラを再作成しない） ---
  const dragRef = useRef<DragState | null>(null);
  const shiftRef = useRef(false);

  // --- 最新値を ref に同期（ハンドラが古い値を参照しないよう） ---
  const transformRef = useRef(transform);
  const viewportRef = useRef(viewport);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const canvasSizeRef = useRef(canvasSize);
  const onViewportChangeRef = useRef(onViewportChange);

  useEffect(() => { transformRef.current = transform; }, [transform]);
  useEffect(() => { viewportRef.current = viewport; }, [viewport]);
  useEffect(() => { imageRef.current = image; }, [image]);
  useEffect(() => { canvasSizeRef.current = canvasSize; }, [canvasSize]);
  useEffect(() => { onViewportChangeRef.current = onViewportChange; }, [onViewportChange]);

  // ----------------------------------------------------------------
  // 初期フィット
  // ----------------------------------------------------------------

  const applyInitialFit = useCallback(() => {
    const img = imageRef.current;
    const { width, height } = canvasSizeRef.current;
    if (!img || !width || !height || hasInitialFitRef.current) return;
    hasInitialFitRef.current = true;

    const padding = 40;
    const scale = Math.min(
      (width - padding) / img.width,
      (height - padding) / img.height,
      1
    );
    const t: Transform = {
      x: (width - img.width * scale) / 2,
      y: (height - img.height * scale) / 2,
      scale,
    };
    setTransform(t);
    transformRef.current = t;
  }, []);

  // ----------------------------------------------------------------
  // ResizeObserver - canvas を container に合わせてリサイズ
  // ----------------------------------------------------------------

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width === 0 || height === 0) return;

      const canvas = canvasRef.current;
      if (!canvas) return;

      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      canvasSizeRef.current = { width, height };
      setCanvasSize({ width, height });

      // canvas が確定したので初期フィット試行
      applyInitialFit();
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, [applyInitialFit]);

  // ----------------------------------------------------------------
  // 画像読み込み
  // ----------------------------------------------------------------

  useEffect(() => {
    hasInitialFitRef.current = false;
    setImage(null);
    imageRef.current = null;
    setIsLoading(true);

    loadAssetFileAsDataUrl(assetUuid).then((dataUrl) => {
      if (!dataUrl) {
        setIsLoading(false);
        return;
      }
      const img = new Image();
      img.onload = () => {
        imageRef.current = img;
        setImage(img);
        setIsLoading(false);
        onAspectRatioDetected?.(img.width / img.height);
        // canvas が既に確定していれば即フィット
        applyInitialFit();
      };
      img.src = dataUrl;
    });
  }, [assetUuid, onAspectRatioDetected, applyInitialFit]);

  // ----------------------------------------------------------------
  // 描画
  // ----------------------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !image || canvasSize.width === 0) return;

    const dpr = window.devicePixelRatio || 1;
    const t = transform;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(dpr, dpr);
    ctx.translate(t.x, t.y);
    ctx.scale(t.scale, t.scale);

    // 画像
    ctx.drawImage(image, 0, 0);

    // クロップ領域（viewport が 0 の場合は全体）
    const cx = viewport.width === 0 ? 0 : viewport.x;
    const cy = viewport.height === 0 ? 0 : viewport.y;
    const cw = viewport.width === 0 ? image.width : viewport.width;
    const ch = viewport.height === 0 ? image.height : viewport.height;

    // 外側をグレーアウト
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, image.width, cy);
    ctx.fillRect(0, cy + ch, image.width, image.height - cy - ch);
    ctx.fillRect(0, cy, cx, ch);
    ctx.fillRect(cx + cw, cy, image.width - cx - cw, ch);

    // クロップ枠
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 2 / t.scale;
    ctx.setLineDash([6 / t.scale, 4 / t.scale]);
    ctx.strokeRect(cx, cy, cw, ch);
    ctx.setLineDash([]);

    // コーナーハンドル
    const hs = 8 / t.scale;
    ctx.fillStyle = '#3b82f6';
    for (const [hx, hy] of [[cx, cy], [cx + cw, cy], [cx + cw, cy + ch], [cx, cy + ch]]) {
      ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
    }
  }, [image, transform, viewport, canvasSize]);

  // ----------------------------------------------------------------
  // キーボード
  // ----------------------------------------------------------------

  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.key === 'Shift') shiftRef.current = true; };
    const up = (e: KeyboardEvent) => { if (e.key === 'Shift') shiftRef.current = false; };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // ----------------------------------------------------------------
  // 座標変換ヘルパー
  // ----------------------------------------------------------------

  const screenToImage = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const t = transformRef.current;
    return {
      x: (clientX - rect.left - t.x) / t.scale,
      y: (clientY - rect.top - t.y) / t.scale,
    };
  }, []);

  // ----------------------------------------------------------------
  // ポインタイベント
  // ----------------------------------------------------------------

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const img = imageRef.current;
    if (!img) return;

    const pt = screenToImage(e.clientX, e.clientY);
    const t = transformRef.current;
    const vp = viewportRef.current;

    const cx = vp.width === 0 ? 0 : vp.x;
    const cy = vp.height === 0 ? 0 : vp.y;
    const cw = vp.width === 0 ? img.width : vp.width;
    const ch = vp.height === 0 ? img.height : vp.height;
    const hs = 14 / t.scale;

    const corners: [DragMode, number, number][] = [
      ['resize-nw', cx,      cy],
      ['resize-ne', cx + cw, cy],
      ['resize-se', cx + cw, cy + ch],
      ['resize-sw', cx,      cy + ch],
    ];

    for (const [mode, hx, hy] of corners) {
      if (Math.abs(pt.x - hx) < hs && Math.abs(pt.y - hy) < hs) {
        dragRef.current = { mode, startImgX: pt.x, startImgY: pt.y, startVp: { x: cx, y: cy, width: cw, height: ch } };
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        return;
      }
    }

    if (pt.x >= cx && pt.x <= cx + cw && pt.y >= cy && pt.y <= cy + ch) {
      dragRef.current = { mode: 'move', startImgX: pt.x, startImgY: pt.y, startVp: { x: cx, y: cy, width: cw, height: ch } };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    }
  }, [screenToImage]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current;
    const img = imageRef.current;
    if (!d || d.mode === 'none' || !img) return;

    const pt = screenToImage(e.clientX, e.clientY);
    const dx = pt.x - d.startImgX;
    const dy = pt.y - d.startImgY;
    const sv = d.startVp;
    const ar = sv.width / sv.height;

    if (d.mode === 'move') {
      onViewportChangeRef.current({
        ...sv,
        x: Math.max(0, Math.min(img.width - sv.width, sv.x + dx)),
        y: Math.max(0, Math.min(img.height - sv.height, sv.y + dy)),
      });
      return;
    }

    let nx = sv.x, ny = sv.y, nw = sv.width, nh = sv.height;

    switch (d.mode) {
      case 'resize-se':
        nw = Math.max(20, sv.width + dx);
        nh = Math.max(20, sv.height + dy);
        if (shiftRef.current) nh = nw / ar;
        break;
      case 'resize-sw':
        nx = sv.x + dx;
        nw = Math.max(20, sv.width - dx);
        nh = Math.max(20, sv.height + dy);
        if (shiftRef.current) nh = nw / ar;
        break;
      case 'resize-ne':
        nw = Math.max(20, sv.width + dx);
        ny = sv.y + dy;
        nh = Math.max(20, sv.height - dy);
        if (shiftRef.current) { nh = nw / ar; ny = sv.y + sv.height - nh; }
        break;
      case 'resize-nw':
        nx = sv.x + dx;
        nw = Math.max(20, sv.width - dx);
        ny = sv.y + dy;
        nh = Math.max(20, sv.height - dy);
        if (shiftRef.current) { nh = nw / ar; ny = sv.y + sv.height - nh; }
        break;
    }

    nx = Math.max(0, nx);
    ny = Math.max(0, ny);
    nw = Math.min(nw, img.width - nx);
    nh = Math.min(nh, img.height - ny);

    onViewportChangeRef.current({ x: nx, y: ny, width: nw, height: nh });
  }, [screenToImage]);

  const handlePointerUp = useCallback(() => { dragRef.current = null; }, []);

  const handleWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const t = transformRef.current;
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    const newScale = Math.max(0.05, Math.min(20, t.scale * factor));
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const nt: Transform = {
      x: mx - (mx - t.x) * (newScale / t.scale),
      y: my - (my - t.y) * (newScale / t.scale),
      scale: newScale,
    };
    setTransform(nt);
    transformRef.current = nt;
  }, []);

  // ----------------------------------------------------------------
  // レンダリング
  // ※ early return を使わず常に同じ DOM 構造を返す。
  //   そうしないと containerRef が null のまま ResizeObserver が observe できない。
  // ----------------------------------------------------------------

  return (
    <div className="viewport-editor-image">
      <div ref={containerRef} className="viewport-editor-canvas-container">
        {/* ローディング・エラーはオーバーレイで表示 */}
        {isLoading && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1 }}>
            読み込み中...
          </div>
        )}
        {!isLoading && !image && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1 }}>
            画像を読み込めませんでした
          </div>
        )}
        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
          onWheel={handleWheel}
          style={{ cursor: image ? 'crosshair' : 'default' }}
        />
      </div>
      <div className="viewport-editor-toolbar">
        <button
          className="viewport-editor-btn"
          onClick={() => onViewportChange({ x: 0, y: 0, width: 0, height: 0 })}
        >
          全体表示に戻す
        </button>
        <span className="viewport-editor-hint">
          Shift + ドラッグでアスペクト比固定
        </span>
      </div>
    </div>
  );
}