/**
 * ViewportEditorBoard - ボードの表示領域設定
 *
 * canvas サイズは ResizeObserver で自律管理。
 * ボードコンテンツ（ストローク・オーバーレイ）をプレビュー表示し、
 * 表示領域（Viewport）の矩形をドラッグで移動・リサイズする。
 *
 * 操作:
 *   - 矩形の内側をドラッグ → 移動
 *   - 矩形の四隅をドラッグ → リサイズ（Shift でアスペクト比固定）
 *   - 矩形の外側をドラッグ → キャンバスをパン
 *   - Space + ドラッグ → キャンバスをパン
 *   - ホイール → ズーム
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useProjectStore } from '../hooks/useProjectStore';
import { computeState, getActiveStrokes, getActiveOverlays } from '../utils/statemachine';
import { loadAssetFileAsDataUrl } from '../utils/storage';
import { loadPdfDocument, renderPdfPage } from '../utils/pdf';
import type { DrawEvent, OverlayState } from '../types';

// ----------------------------------------------------------------
// 型
// ----------------------------------------------------------------

type Viewport = { x: number; y: number; width: number; height: number };
type Transform = { x: number; y: number; scale: number };
type DragMode = 'none' | 'pan' | 'move' | 'resize-nw' | 'resize-ne' | 'resize-se' | 'resize-sw';

interface DragState {
  mode: DragMode;
  startScreenX: number;
  startScreenY: number;
  startVp: Viewport;
  startTransform: Transform;
}

// ボードのデフォルトビューポート（初期フィット計算用）
export const DEFAULT_BOARD_VIEWPORT: Viewport = {
  x: -960, y: -540, width: 1920, height: 1080,
};

export interface ViewportEditorBoardProps {
  assetUuid: string;
  viewport: Viewport;
  onViewportChange: (vp: Viewport) => void;
  /** viewport={0,0,0,0} のとき applyInitialFit が決定した実効初期 viewport を通知 */
  onInitialViewportReady?: (vp: Viewport) => void;
}

// ----------------------------------------------------------------
// コンポーネント
// ----------------------------------------------------------------

export function ViewportEditorBoard({
  assetUuid,
  viewport,
  onViewportChange,
  onInitialViewportReady,
}: ViewportEditorBoardProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { project, loadBoardEventsAsync, getBoards, getBoardUuid, loadBoardSnapshot } = useProjectStore();

  // --- コンテンツ ---
  const [strokes, setStrokes] = useState<DrawEvent[]>([]);
  const [overlays, setOverlays] = useState<OverlayState[]>([]);
  const [overlayImages, setOverlayImages] = useState<Map<string, HTMLImageElement>>(new Map());
  const [isLoading, setIsLoading] = useState(true);
  const [isContentReady, setIsContentReady] = useState(false);

  // --- 表示変換 ---
  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, scale: 1 });

  // --- canvas の論理サイズ ---
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

  // --- 初期フィット済みフラグ ---
  const hasInitialFitRef = useRef(false);
  // viewport={0,0,0,0} のときの代替 viewport（コンテンツ BBox から計算）
  const contentBBoxRef = useRef<Viewport | null>(null);

  // --- ドラッグ・キー状態 ---
  const dragRef = useRef<DragState | null>(null);
  const shiftRef = useRef(false);
  const spaceRef = useRef(false);

  // --- 最新値 ref ---
  const transformRef = useRef(transform);
  const viewportRef = useRef(viewport);
  const canvasSizeRef = useRef(canvasSize);
  const onViewportChangeRef = useRef(onViewportChange);
  const strokesRef = useRef(strokes);
  const overlaysRef = useRef(overlays);
  const overlayImagesRef = useRef(overlayImages);

  useEffect(() => { transformRef.current = transform; }, [transform]);
  useEffect(() => { viewportRef.current = viewport; }, [viewport]);
  useEffect(() => { canvasSizeRef.current = canvasSize; }, [canvasSize]);
  useEffect(() => { onViewportChangeRef.current = onViewportChange; }, [onViewportChange]);
  useEffect(() => { strokesRef.current = strokes; }, [strokes]);
  useEffect(() => { overlaysRef.current = overlays; }, [overlays]);
  useEffect(() => { overlayImagesRef.current = overlayImages; }, [overlayImages]);

  // ----------------------------------------------------------------
  // 初期フィット
  // ----------------------------------------------------------------

  const applyInitialFit = useCallback(() => {
    const { width, height } = canvasSizeRef.current;
    if (!width || !height || !isContentReady || hasInitialFitRef.current) return;
    hasInitialFitRef.current = true;

    const vp = viewportRef.current;

    // viewport が {0,0,0,0}（センチネル値）のとき、
    // コンテンツ BBox を初期 viewport として使う（renderBoardToImage と同じ範囲）
    // → ホワイトボード上の overlay AR と一致させるため
    const fitVp = (vp.width > 0 && vp.height > 0)
      ? vp
      : (contentBBoxRef.current ?? DEFAULT_BOARD_VIEWPORT);

    if (vp.width === 0) {
      onViewportChangeRef.current(fitVp);
      // 実効初期 viewport を BoardEditor に通知（handleApplyViewport の vpOld として使用）
      onInitialViewportReady?.(fitVp);
    }

    const padding = 80;
    const scale = Math.min(
      (width - padding) / fitVp.width,
      (height - padding) / fitVp.height,
      1
    );
    const vpCenterX = fitVp.x + fitVp.width / 2;
    const vpCenterY = fitVp.y + fitVp.height / 2;
    const t: Transform = {
      x: width / 2 - vpCenterX * scale,
      y: height / 2 - vpCenterY * scale,
      scale,
    };
    setTransform(t);
    transformRef.current = t;
  }, [isContentReady]);

  // ----------------------------------------------------------------
  // ResizeObserver
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
      applyInitialFit();
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, [applyInitialFit]);

  // isContentReady になったときも試みる
  useEffect(() => {
    if (isContentReady) applyInitialFit();
  }, [isContentReady, applyInitialFit]);

  // ----------------------------------------------------------------
  // ボードデータ読み込み
  // ----------------------------------------------------------------

  useEffect(() => {
    if (!project) return;

    // assetUuid からボード ID を検索
    let boardId: string | null = null;
    for (const board of getBoards()) {
      if (getBoardUuid(board.id) === assetUuid) {
        boardId = board.id;
        break;
      }
    }
    if (!boardId) {
      setIsLoading(false);
      setIsContentReady(true);
      return;
    }

    hasInitialFitRef.current = false;
    setIsContentReady(false);
    setIsLoading(true);

    loadBoardEventsAsync(boardId).then((events: import('../types').WbelxEvent[]) => {
      const state = computeState(events);
      const loadedStrokes = getActiveStrokes(state);
      const loadedOverlays = getActiveOverlays(state);
      setStrokes(loadedStrokes);
      setOverlays(loadedOverlays);

      // コンテンツ BBox を計算（viewport={0,0,0,0} 時の初期 viewport として使用）
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const s of loadedStrokes) {
        if (s.bbox) {
          minX = Math.min(minX, s.bbox[0]); minY = Math.min(minY, s.bbox[1]);
          maxX = Math.max(maxX, s.bbox[2]); maxY = Math.max(maxY, s.bbox[3]);
        }
      }
      for (const o of loadedOverlays) {
        minX = Math.min(minX, o.x); minY = Math.min(minY, o.y);
        maxX = Math.max(maxX, o.x + o.width); maxY = Math.max(maxY, o.y + o.height);
      }

      if (minX !== Infinity) {
        const margin = 50;
        contentBBoxRef.current = {
          x: minX - margin, y: minY - margin,
          width:  maxX - minX + margin * 2,
          height: maxY - minY + margin * 2,
        };
      } else {
        // コンテンツ空 → DEFAULT_BOARD_VIEWPORT にフォールバック
        contentBBoxRef.current = DEFAULT_BOARD_VIEWPORT;
      }

      setIsLoading(false);
      setIsContentReady(true);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetUuid, project]); // viewport は意図的に除外（変更のたびに再ロードしない）

  // ----------------------------------------------------------------
  // board サブオーバーレイのサムネイル生成（簡易版・ストロークのみ）
  // ----------------------------------------------------------------

  const renderSubBoardToImage = useCallback(async (subOv: OverlayState): Promise<HTMLImageElement | null> => {
    let boardId: string | null = null;
    for (const board of getBoards()) {
      if (getBoardUuid(board.id) === subOv.assetUuid) { boardId = board.id; break; }
    }
    if (!boardId) return null;

    let events;
    try {
      const snap = await loadBoardSnapshot(boardId);
      events = snap?.length ? snap : await loadBoardEventsAsync(boardId);
    } catch { return null; }

    const boardState = computeState(events);
    const boardStrokes = getActiveStrokes(boardState);
    const boardSubOverlays = getActiveOverlays(boardState);

    const vp = subOv.viewport;
    const hasVp = vp.width > 0 && vp.height > 0;
    const minX = hasVp ? vp.x : -960;
    const minY = hasVp ? vp.y : -540;
    const maxX = hasVp ? vp.x + vp.width : 960;
    const maxY = hasVp ? vp.y + vp.height : 540;

    const contentW = Math.max(maxX - minX, 1);
    const contentH = Math.max(maxY - minY, 1);
    const thumbW = Math.min(Math.ceil(subOv.width * (window.devicePixelRatio || 1) * 1.5), 2048);
    const thumbH = Math.round(thumbW / (contentW / contentH));
    const scale = thumbW / contentW;

    const tc = document.createElement('canvas');
    tc.width = thumbW; tc.height = thumbH;
    const tctx = tc.getContext('2d')!;
    tctx.fillStyle = '#f9fafb';
    tctx.fillRect(0, 0, thumbW, thumbH);

    tctx.save();
    tctx.scale(scale, scale);
    tctx.translate(-minX, -minY);

    // サブオーバーレイはグレープレースホルダー
    for (const o of boardSubOverlays) {
      tctx.fillStyle = '#d1d5db';
      tctx.fillRect(o.x, o.y, o.width, o.height);
    }

    tctx.lineCap = 'round'; tctx.lineJoin = 'round';
    for (const stroke of boardStrokes) {
      tctx.strokeStyle = stroke.color;
      tctx.lineWidth = stroke.width;
      tctx.stroke(new Path2D(stroke.path));
    }
    tctx.restore();

    const img = new Image();
    img.src = tc.toDataURL('image/png');
    await new Promise<void>(r => { img.onload = () => r(); });
    return img;
  }, [getBoards, getBoardUuid, loadBoardSnapshot, loadBoardEventsAsync]);

  // ----------------------------------------------------------------
  // オーバーレイ画像読み込み（overlayId をキーに、型別ローダーを使用）
  // ----------------------------------------------------------------

  useEffect(() => {
    if (overlays.length === 0 || !project) return;

    const current = overlayImagesRef.current;
    // overlayId でキー管理（同一アセット・異なるページ/viewportに対応）
    const toLoad = overlays.filter((o: OverlayState) => o.assetUuid && !current.has(o.overlayId));
    if (toLoad.length === 0) return;

    let cancelled = false;
    Promise.all(
      toLoad.map(async (o: OverlayState): Promise<[string, HTMLImageElement] | null> => {
        const assetType = project.assetIndex.byUuid.get(o.assetUuid)?.type ?? 'image';
        try {
          if (assetType === 'image') {
            const dataUrl = await loadAssetFileAsDataUrl(o.assetUuid);
            if (!dataUrl) return null;
            const img = new Image();
            await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = rej; img.src = dataUrl; });
            return [o.overlayId, img];
          } else if (assetType === 'document') {
            const dataUrl = await loadAssetFileAsDataUrl(o.assetUuid);
            if (!dataUrl) return null;
            const pdfDoc = await loadPdfDocument(dataUrl);
            const img = await renderPdfPage(pdfDoc, o.page > 0 ? o.page : 1);
            return [o.overlayId, img];
          } else if (assetType === 'board') {
            const img = await renderSubBoardToImage(o);
            return img ? [o.overlayId, img] : null;
          }
        } catch { return null; }
        return null;
      })
    ).then((results) => {
      if (cancelled) return;
      const next = new Map(current);
      for (const r of results) { if (r) next.set(r[0], r[1]); }
      setOverlayImages(next);
    });

    return () => { cancelled = true; };
  }, [overlays, project, renderSubBoardToImage]);

  // ----------------------------------------------------------------
  // グリッド描画ヘルパー
  // ----------------------------------------------------------------

  const drawGrid = useCallback((
    ctx: CanvasRenderingContext2D,
    logicalW: number,
    logicalH: number,
    t: Transform
  ) => {
    const gridSize = 50;
    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = 1 / t.scale;

    const startX = Math.floor(-t.x / t.scale / gridSize) * gridSize;
    const startY = Math.floor(-t.y / t.scale / gridSize) * gridSize;
    const endX = startX + logicalW / t.scale + gridSize * 2;
    const endY = startY + logicalH / t.scale + gridSize * 2;

    ctx.beginPath();
    for (let x = startX; x < endX; x += gridSize) {
      ctx.moveTo(x, startY); ctx.lineTo(x, endY);
    }
    for (let y = startY; y < endY; y += gridSize) {
      ctx.moveTo(startX, y); ctx.lineTo(endX, y);
    }
    ctx.stroke();
  }, []);

  // ----------------------------------------------------------------
  // 描画
  // ----------------------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || canvasSize.width === 0) return;

    const dpr = window.devicePixelRatio || 1;
    const t = transform;
    const lw = canvasSize.width;
    const lh = canvasSize.height;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#f9fafb';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(dpr, dpr);

    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.scale(t.scale, t.scale);

    // グリッド
    drawGrid(ctx, lw, lh, t);

    // オーバーレイ
    for (const overlay of overlays) {
      const img = overlayImages.get(overlay.overlayId);  // overlayId でルックアップ
      const assetType = project?.assetIndex.byUuid.get(overlay.assetUuid)?.type ?? 'image';
      ctx.save();
      ctx.globalAlpha = overlay.opacity;
      if (img && img.complete) {
        // board はサムネイルに viewport が焼き込み済みなのでそのまま描画
        // image/document は viewport を source rect として適用（WhiteboardCanvas と同じ処理）
        if (assetType !== 'board' && overlay.viewport.width > 0 && overlay.viewport.height > 0) {
          ctx.drawImage(
            img,
            overlay.viewport.x, overlay.viewport.y, overlay.viewport.width, overlay.viewport.height,
            overlay.x, overlay.y, overlay.width, overlay.height
          );
        } else {
          ctx.drawImage(img, overlay.x, overlay.y, overlay.width, overlay.height);
        }
      } else {
        ctx.fillStyle = '#e5e7eb';
        ctx.fillRect(overlay.x, overlay.y, overlay.width, overlay.height);
      }
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

    // --- ビューポート矩形（スクリーン座標で描く） ---
    const vp = viewport.width === 0 ? DEFAULT_BOARD_VIEWPORT : viewport;
    const sx = vp.x * t.scale + t.x;
    const sy = vp.y * t.scale + t.y;
    const sw = vp.width * t.scale;
    const sh = vp.height * t.scale;

    // 外側グレーアウト
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, lw, sy);
    ctx.fillRect(0, sy + sh, lw, lh - sy - sh);
    ctx.fillRect(0, sy, sx, sh);
    ctx.fillRect(sx + sw, sy, lw - sx - sw, sh);

    // 枠
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(sx, sy, sw, sh);
    ctx.setLineDash([]);

    // コーナーハンドル
    const hs = 8;
    ctx.fillStyle = '#3b82f6';
    for (const [hx, hy] of [[sx, sy], [sx + sw, sy], [sx + sw, sy + sh], [sx, sy + sh]]) {
      ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
    }
  }, [strokes, overlays, overlayImages, transform, viewport, canvasSize, drawGrid, project]);

  // ----------------------------------------------------------------
  // キーボード
  // ----------------------------------------------------------------

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Shift') shiftRef.current = true;
      if (e.key === ' ') { e.preventDefault(); spaceRef.current = true; }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Shift') shiftRef.current = false;
      if (e.key === ' ') spaceRef.current = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // ----------------------------------------------------------------
  // ポインタイベント
  // ----------------------------------------------------------------

  const getScreenPos = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const sp = getScreenPos(e.clientX, e.clientY);
    const t = transformRef.current;
    const vp = viewportRef.current;
    const cvp = vp.width === 0 ? DEFAULT_BOARD_VIEWPORT : vp;

    // スクリーン座標でのビューポート矩形
    const sx = cvp.x * t.scale + t.x;
    const sy = cvp.y * t.scale + t.y;
    const sw = cvp.width * t.scale;
    const sh = cvp.height * t.scale;
    const hs = 14;

    if (spaceRef.current) {
      dragRef.current = { mode: 'pan', startScreenX: sp.x, startScreenY: sp.y, startVp: cvp, startTransform: { ...t } };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }

    const corners: [DragMode, number, number][] = [
      ['resize-nw', sx,      sy],
      ['resize-ne', sx + sw, sy],
      ['resize-se', sx + sw, sy + sh],
      ['resize-sw', sx,      sy + sh],
    ];

    for (const [mode, hx, hy] of corners) {
      if (Math.abs(sp.x - hx) < hs && Math.abs(sp.y - hy) < hs) {
        dragRef.current = { mode, startScreenX: sp.x, startScreenY: sp.y, startVp: cvp, startTransform: { ...t } };
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        return;
      }
    }

    if (sp.x >= sx && sp.x <= sx + sw && sp.y >= sy && sp.y <= sy + sh) {
      dragRef.current = { mode: 'move', startScreenX: sp.x, startScreenY: sp.y, startVp: cvp, startTransform: { ...t } };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }

    // 外側クリック → パン
    dragRef.current = { mode: 'pan', startScreenX: sp.x, startScreenY: sp.y, startVp: cvp, startTransform: { ...t } };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [getScreenPos]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current;
    if (!d || d.mode === 'none') return;

    const sp = getScreenPos(e.clientX, e.clientY);
    const dx = sp.x - d.startScreenX;
    const dy = sp.y - d.startScreenY;
    const t = transformRef.current;

    if (d.mode === 'pan') {
      const nt: Transform = {
        ...d.startTransform,
        x: d.startTransform.x + dx,
        y: d.startTransform.y + dy,
      };
      setTransform(nt);
      transformRef.current = nt;
      return;
    }

    // ボード座標でのデルタ
    const dxB = dx / t.scale;
    const dyB = dy / t.scale;
    const sv = d.startVp;
    const ar = sv.width / sv.height;

    if (d.mode === 'move') {
      onViewportChangeRef.current({
        ...sv,
        x: sv.x + dxB,
        y: sv.y + dyB,
      });
      return;
    }

    let nx = sv.x, ny = sv.y, nw = sv.width, nh = sv.height;

    switch (d.mode) {
      case 'resize-se':
        nw = Math.max(100, sv.width + dxB); nh = Math.max(100, sv.height + dyB);
        if (shiftRef.current) nh = nw / ar;
        break;
      case 'resize-sw':
        nx = sv.x + dxB; nw = Math.max(100, sv.width - dxB); nh = Math.max(100, sv.height + dyB);
        if (shiftRef.current) nh = nw / ar;
        break;
      case 'resize-ne':
        nw = Math.max(100, sv.width + dxB); ny = sv.y + dyB; nh = Math.max(100, sv.height - dyB);
        if (shiftRef.current) { nh = nw / ar; ny = sv.y + sv.height - nh; }
        break;
      case 'resize-nw':
        nx = sv.x + dxB; nw = Math.max(100, sv.width - dxB); ny = sv.y + dyB; nh = Math.max(100, sv.height - dyB);
        if (shiftRef.current) { nh = nw / ar; ny = sv.y + sv.height - nh; }
        break;
    }

    onViewportChangeRef.current({ x: nx, y: ny, width: nw, height: nh });
  }, [getScreenPos]);

  const handlePointerUp = useCallback(() => { dragRef.current = null; }, []);

  const handleWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const t = transformRef.current;
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    const newScale = Math.max(0.02, Math.min(10, t.scale * factor));
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
  // ツールバーアクション
  // ----------------------------------------------------------------

  // ビューポート矩形を canvas 中央に表示
  const handleCenterViewport = useCallback(() => {
    const { width, height } = canvasSizeRef.current;
    if (!width || !height) return;
    const vp = viewportRef.current.width === 0 ? DEFAULT_BOARD_VIEWPORT : viewportRef.current;

    // 縦横ともに溢れないスケールを計算（applyInitialFit と同じロジック）
    const padding = 80;
    const scale = Math.min(
      (width  - padding) / vp.width,
      (height - padding) / vp.height,
      1
    );
    const vpCX = vp.x + vp.width  / 2;
    const vpCY = vp.y + vp.height / 2;
    const nt: Transform = {
      x: width  / 2 - vpCX * scale,
      y: height / 2 - vpCY * scale,
      scale,
    };
    setTransform(nt);
    transformRef.current = nt;
  }, []);

  // コンテンツ全体にフィット
  const handleFitContent = useCallback(() => {
    const { width, height } = canvasSizeRef.current;
    if (!width || !height) return;
    const s = strokesRef.current;
    const o = overlaysRef.current;
    if (s.length === 0 && o.length === 0) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const stroke of s) {
      if (stroke.bbox) {
        minX = Math.min(minX, stroke.bbox[0]); minY = Math.min(minY, stroke.bbox[1]);
        maxX = Math.max(maxX, stroke.bbox[2]); maxY = Math.max(maxY, stroke.bbox[3]);
      }
    }
    for (const ov of o) {
      minX = Math.min(minX, ov.x); minY = Math.min(minY, ov.y);
      maxX = Math.max(maxX, ov.x + ov.width); maxY = Math.max(maxY, ov.y + ov.height);
    }
    if (minX === Infinity) return;

    const margin = 50;
    onViewportChangeRef.current({
      x: minX - margin,
      y: minY - margin,
      width: maxX - minX + margin * 2,
      height: maxY - minY + margin * 2,
    });
  }, []);

  // ----------------------------------------------------------------
  // レンダリング
  // ※ early return を使わず常に同じ DOM 構造を返す。
  // ----------------------------------------------------------------

  return (
    <div
      className="viewport-editor-board"
      style={{ cursor: spaceRef.current ? 'grab' : 'default' }}
    >
      <div ref={containerRef} className="viewport-editor-canvas-container">
        {isLoading && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1 }}>
            ボードを読み込み中...
          </div>
        )}
        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
          onWheel={handleWheel}
        />
      </div>
      <div className="viewport-editor-toolbar">
        <button className="viewport-editor-btn" onClick={handleCenterViewport}>領域を中央に表示</button>
        <button className="viewport-editor-btn" onClick={handleFitContent}>内容にフィット</button>
        <button className="viewport-editor-btn" onClick={() => onViewportChange(DEFAULT_BOARD_VIEWPORT)}>リセット</button>
        <span className="viewport-editor-hint">
          Space + ドラッグでパン　/　Shift + ドラッグでアスペクト比固定
        </span>
      </div>
    </div>
  );
}
