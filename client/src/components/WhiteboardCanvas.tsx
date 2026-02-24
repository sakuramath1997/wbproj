import { useRef, useEffect, useState, useCallback } from 'react';
import type { OverlayDisplayState } from '../types/overlay-display';
import type { 
  ToolType, 
  Point, 
  ActiveStroke, 
  CanvasTransform, 
  DrawEvent,
  CursorInfo,
  OverlayState,
  AssetType,
  BackgroundConfig,
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

// ドラッグ状態の型
type DragMode = 'none' | 'move'
  | 'resize-nw' | 'resize-ne' | 'resize-se' | 'resize-sw'
  | 'resize-n' | 'resize-s' | 'resize-e' | 'resize-w';

// 投げ縄リサイズモード
type LassoResizeMode = 'none' | 'move'
  | 'resize-nw' | 'resize-ne' | 'resize-se' | 'resize-sw'  // 四隅: AR 保持
  | 'resize-n' | 'resize-s' | 'resize-e' | 'resize-w';      // 辺中央: 単軸

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
  /** ドラッグ中のリアルタイム透明度プレビュー用（overlayId → opacity） */
  overlayOpacityOverrides?: Map<string, number>;
  /** AR ロック設定（overlayId → locked, デフォルト true） */
  overlayLockAspectRatios?: Map<string, boolean>;
  /** 背景設定（project.toml の [background]） */
  backgroundConfig?: BackgroundConfig;
  /** 固定キャンバスサイズ（省略 = 無限キャンバス） */
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
  /** 投げ縄: 選択状態変更通知 */
  onLassoSelectionChange?: (selection: LassoSelection | null) => void;
  /** 投げ縄: ストローク+オーバーレイ移動 */
  onLassoMove?: (
    originalStrokes: DrawEvent[], movedStrokes: DrawEvent[],
    overlayDeltas: Array<{overlayId: string; dx: number; dy: number}>,
  ) => void;
  /** 投げ縄: ストローク+オーバーレイ削除 */
  onLassoDelete?: (strokes: DrawEvent[], overlayIds: string[]) => void;
  /** 外部から投げ縄選択を設定（複製/貼り付け後の選択状態反映用） */
  externalLassoSelection?: LassoSelection | null;
}

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
  
  // キャンバス変換（パン/ズーム）
  const [transform, setTransform] = useState<CanvasTransform>({ x: 0, y: 0, scale: 1 });
  
  // 描画中のストローク
  const activeStrokeRef = useRef<ActiveStroke | null>(null);
  const [currentStroke, setCurrentStroke] = useState<ActiveStroke | null>(null);
  
  // パン操作中
  const isPanningRef = useRef(false);
  const lastPanPointRef = useRef<Point | null>(null);

  // オーバーレイドラッグ
  const dragModeRef = useRef<DragMode>('none');
  const dragStartRef = useRef<Point | null>(null);
  const dragOverlayInitialRef = useRef<{ x: number; y: number; width: number; height: number; rotation: number } | null>(null);
  const [dragPreview, setDragPreview] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [shiftPressed, setShiftPressed] = useState(false);

  // 投げ縄
  const lassoPathRef = useRef<Point[]>([]);
  const [lassoPath, setLassoPath] = useState<Point[]>([]);
  const [lassoSelectedIds, setLassoSelectedIds] = useState<Set<string>>(new Set());
  const [lassoSelectedOverlayIds, setLassoSelectedOverlayIds] = useState<Set<string>>(new Set());
  const lassoDragStartRef = useRef<Point | null>(null);
  const [lassoDragOffset, setLassoDragOffset] = useState<Point | null>(null);
  // 投げ縄リサイズ
  const lassoResizeModeRef = useRef<LassoResizeMode>('none');
  const lassoInitialBboxRef = useRef<[number, number, number, number] | null>(null); // [minX, minY, maxX, maxY]
  const [lassoScalePreview, setLassoScalePreview] = useState<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  // 投げ縄: ツール切替時に選択・パスをクリア
  useEffect(() => {
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
  }, [tool]);

  // 投げ縄選択状態を親に通知
  useEffect(() => {
    if (lassoSelectedIds.size === 0 && lassoSelectedOverlayIds.size === 0) {
      onLassoSelectionChange?.(null);
    } else {
      onLassoSelectionChange?.({ strokeIds: lassoSelectedIds, overlayIds: lassoSelectedOverlayIds });
    }
  }, [lassoSelectedIds, lassoSelectedOverlayIds, onLassoSelectionChange]);

  // 外部からの投げ縄選択設定（複製/貼り付け後の選択状態反映）
  const prevExternalSelectionRef = useRef<LassoSelection | null | undefined>(undefined);
  useEffect(() => {
    if (externalLassoSelection !== prevExternalSelectionRef.current && externalLassoSelection) {
      setLassoSelectedIds(externalLassoSelection.strokeIds);
      setLassoSelectedOverlayIds(externalLassoSelection.overlayIds);
    }
    prevExternalSelectionRef.current = externalLassoSelection;
  }, [externalLassoSelection]);

  // Shift キー監視
  // transform 変化を親に通知（ボードサムネイル解像度更新用）
  useEffect(() => {
    onTransformChange?.(transform);
  }, [transform, onTransformChange]);
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

  // キャンバスサイズ調整

  // 選択されたオーバーレイが変更されたら、ドラッグ状態をリセット
  useEffect(() => {
    dragModeRef.current = 'none';
    dragStartRef.current = null;
    dragOverlayInitialRef.current = null;
    setDragPreview(null);
  }, [selectedOverlayId]);

  // マルチタッチ用
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const lastPinchDistRef = useRef<number | null>(null);
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
  }, []);

  // 描画関数
  // ----------------------------------------------------------------
  // スピナー描画ヘルパー（canvas 座標系で呼ぶ）
  // hasExistingImage=true のとき: 半透明フィルム + 隅スピナー
  // hasExistingImage=false のとき: 中央スピナー
  // ----------------------------------------------------------------
  const drawLoadingOverlay = useCallback((
    ctx: CanvasRenderingContext2D,
    x: number, y: number, w: number, h: number,
    scale: number,
    hasExistingImage: boolean,
  ) => {
    const angle = (Date.now() / 600) * Math.PI * 2; // 0.6s で1回転
    const r = Math.min(12, Math.min(w, h) * 0.12) / scale; // 半径（最大12論理px）

    if (hasExistingImage) {
      // 既存画像の上に薄いフィルム
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillRect(x, y, w, h);
      // 右下隅にスピナー
      const cx = x + w - r * 1.8;
      const cy = y + h - r * 1.8;
      drawSpinner(ctx, cx, cy, r, angle, scale);
    } else {
      // 中央にスピナー
      const cx = x + w / 2;
      const cy = y + h / 2;
      drawSpinner(ctx, cx, cy, r, angle, scale);
    }
  }, []);

  const drawSpinner = useCallback((
    ctx: CanvasRenderingContext2D,
    cx: number, cy: number, r: number,
    angle: number, scale: number,
  ) => {
    // 背景円
    ctx.beginPath();
    ctx.arc(cx, cy, r + 2 / scale, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fill();

    // スピナー弧
    ctx.beginPath();
    ctx.arc(cx, cy, r, angle, angle + Math.PI * 1.4);
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = Math.max(2 / scale, 0.5);
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.lineCap = 'butt';
  }, []);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;

    // クリア
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    if (canvasSize) {
      // 固定サイズ: 外側をグレー、キャンバス領域を背景色で塗る
      ctx.fillStyle = '#e5e7eb';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.translate(transform.x, transform.y);
      ctx.scale(transform.scale, transform.scale);

      // キャンバス領域の影
      ctx.shadowColor = 'rgba(0,0,0,0.15)';
      ctx.shadowBlur = 12 / transform.scale;
      ctx.shadowOffsetX = 2 / transform.scale;
      ctx.shadowOffsetY = 2 / transform.scale;
      ctx.fillStyle = backgroundConfig?.color || '#ffffff';
      ctx.fillRect(0, 0, canvasSize.width, canvasSize.height);
      ctx.shadowColor = 'transparent';

      // パターンはキャンバス領域内のみ
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, canvasSize.width, canvasSize.height);
      ctx.clip();
      drawBackground(ctx, canvas.width / dpr, canvas.height / dpr, transform, backgroundConfig);
      ctx.restore();

      ctx.restore();
    } else {
      // 無限キャンバス: 全面を背景色で塗る
      ctx.fillStyle = backgroundConfig?.color || '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    // 変換適用
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.scale, transform.scale);
    
    // 無限キャンバスの場合のみここでパターン描画（固定サイズは上で描画済み）
    if (!canvasSize) {
      drawBackground(ctx, canvas.width / dpr, canvas.height / dpr, transform, backgroundConfig);
    }

    // オーバーレイ描画（ストロークより後ろ）
    for (const overlay of activeOverlays) {
      ctx.save();
      ctx.globalAlpha = overlayOpacityOverrides?.get(overlay.overlayId) ?? overlay.opacity;
      
      // ドラッグ中は dragPreview の位置を使用
      const isBeingDragged = selectedOverlayId === overlay.overlayId && dragPreview;
      // 投げ縄ドラッグ中のオフセット
      const isLassoDragged = lassoSelectedOverlayIds.has(overlay.overlayId) && lassoDragOffset;
      let displayX = isBeingDragged ? dragPreview.x : overlay.x;
      let displayY = isBeingDragged ? dragPreview.y : overlay.y;
      if (isLassoDragged) {
        displayX += lassoDragOffset.x;
        displayY += lassoDragOffset.y;
        ctx.globalAlpha *= 0.7; // ドラッグ中は半透明
      }
      const displayWidth = isBeingDragged ? dragPreview.width : overlay.width;
      const displayHeight = isBeingDragged ? dragPreview.height : overlay.height;
      
      // 回転を適用
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
        // board タイプは viewport がサムネイルに焼き込まれているのでそのまま描画
        // image/document タイプは viewport を source rect として指定（高解像度維持）
        if (assetType !== 'board' && overlay.viewport.width > 0 && overlay.viewport.height > 0) {
          ctx.drawImage(
            img,
            overlay.viewport.x, overlay.viewport.y, overlay.viewport.width, overlay.viewport.height,
            displayX, displayY, displayWidth, displayHeight
          );
        } else {
          ctx.drawImage(img, displayX, displayY, displayWidth, displayHeight);
        }

        // ローディング中: 既存画像の上に半透明オーバーレイ + スピナー
        if (status === 'loading') {
          drawLoadingOverlay(ctx, displayX, displayY, displayWidth, displayHeight, transform.scale, true);
        }
      } else if (status === 'transferring') {
        // P2P 転送中: プレースホルダー + プログレスバー
        ctx.fillStyle = '#eff6ff';
        ctx.fillRect(displayX, displayY, displayWidth, displayHeight);
        ctx.strokeStyle = '#60a5fa';
        ctx.lineWidth = 1 / transform.scale;
        ctx.strokeRect(displayX, displayY, displayWidth, displayHeight);
        // プログレスバー
        const barH = Math.max(4 / transform.scale, 2);
        const barY = displayY + displayHeight / 2 - barH / 2;
        const progress = displayState?.progress ?? 0;
        ctx.fillStyle = '#dbeafe';
        ctx.fillRect(displayX + 4 / transform.scale, barY, displayWidth - 8 / transform.scale, barH);
        ctx.fillStyle = '#3b82f6';
        ctx.fillRect(displayX + 4 / transform.scale, barY, (displayWidth - 8 / transform.scale) * progress, barH);
        // パーセンテージ
        const fontSize = Math.max(Math.min(displayWidth * 0.08, 12 / transform.scale), 8 / transform.scale);
        ctx.font = `${fontSize}px sans-serif`;
        ctx.fillStyle = '#2563eb';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`${Math.round(progress * 100)}%`, displayX + displayWidth / 2, barY - 2 / transform.scale);
        // ラベル
        ctx.textBaseline = 'top';
        ctx.fillText('取得中…', displayX + displayWidth / 2, barY + barH + 2 / transform.scale);
      } else if (status === 'error') {
        // エラー: 赤プレースホルダー
        ctx.fillStyle = '#fef2f2';
        ctx.fillRect(displayX, displayY, displayWidth, displayHeight);
        ctx.strokeStyle = '#f87171';
        ctx.lineWidth = 1 / transform.scale;
        ctx.strokeRect(displayX, displayY, displayWidth, displayHeight);
        const fontSize = Math.max(Math.min(displayWidth * 0.08, 14 / transform.scale), 8 / transform.scale);
        ctx.font = `${fontSize}px sans-serif`;
        ctx.fillStyle = '#dc2626';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const msg = displayState?.errorReason === 'decodeFailed' ? 'Decode failed'
          : displayState?.errorReason === 'peerDisconnected' ? 'Peer disconnected'
          : 'Asset not found';
        ctx.fillText(msg, displayX + displayWidth / 2, displayY + displayHeight / 2);
      } else {
        // requesting / loading（画像なし）
        ctx.fillStyle = '#e5e7eb';
        ctx.fillRect(displayX, displayY, displayWidth, displayHeight);
        ctx.strokeStyle = '#9ca3af';
        ctx.lineWidth = 1 / transform.scale;
        ctx.strokeRect(displayX, displayY, displayWidth, displayHeight);
        drawLoadingOverlay(ctx, displayX, displayY, displayWidth, displayHeight, transform.scale, false);
      }
      
      // 選択枠を描画
      if (selectedOverlayId === overlay.overlayId) {
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 2 / transform.scale;
        ctx.setLineDash([5 / transform.scale, 5 / transform.scale]);
        ctx.strokeRect(displayX, displayY, displayWidth, displayHeight);
        ctx.setLineDash([]);
        
        // 8 ハンドル
        const hs = 4 / transform.scale;        const hmx = displayX + displayWidth / 2;
        const hmy = displayY + displayHeight / 2;
        drawResizeHandles(ctx, transform.scale, hs,
          displayX, displayY, displayX + displayWidth, displayY + displayHeight, hmx, hmy);
      }
      
      ctx.restore();
    }

    // 確定済みストローク描画
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const stroke of activeStrokes) {
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.width;
      const path = new Path2D(stroke.path);
      ctx.stroke(path);
    }

    // 描画中のストローク
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

    // 投げ縄: 選択ストローク+オーバーレイのハイライト
    if (lassoSelectedIds.size > 0 || lassoSelectedOverlayIds.size > 0) {
      const dx = lassoDragOffset?.x ?? 0;
      const dy = lassoDragOffset?.y ?? 0;
      const sp = lassoScalePreview; // { sx, sy, ox, oy } | null
      const isTransforming = (dx !== 0 || dy !== 0 || sp !== null);
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // 元位置の bbox（ハンドル配置用）
      let bMinX = Infinity, bMinY = Infinity, bMaxX = -Infinity, bMaxY = -Infinity;
      for (const stroke of activeStrokes) {
        if (!lassoSelectedIds.has(stroke.id)) continue;
        if (stroke.bbox) {
          bMinX = Math.min(bMinX, stroke.bbox[0]);
          bMinY = Math.min(bMinY, stroke.bbox[1]);
          bMaxX = Math.max(bMaxX, stroke.bbox[2]);
          bMaxY = Math.max(bMaxY, stroke.bbox[3]);
        }
      }
      // オーバーレイの BBox も含める
      for (const overlay of activeOverlays) {
        if (!lassoSelectedOverlayIds.has(overlay.overlayId)) continue;
        bMinX = Math.min(bMinX, overlay.x);
        bMinY = Math.min(bMinY, overlay.y);
        bMaxX = Math.max(bMaxX, overlay.x + overlay.width);
        bMaxY = Math.max(bMaxY, overlay.y + overlay.height);
      }

      // 選択オーバーレイのハイライト描画
      for (const overlay of activeOverlays) {
        if (!lassoSelectedOverlayIds.has(overlay.overlayId)) continue;
        ctx.save();
        ctx.globalAlpha = isTransforming ? 0.6 : 1;
        const ox = overlay.x + dx;
        const oy = overlay.y + dy;
        // ブルーハロ枠
        ctx.strokeStyle = 'rgba(59, 130, 246, 0.5)';
        ctx.lineWidth = 2 / transform.scale;
        ctx.strokeRect(ox, oy, overlay.width, overlay.height);
        ctx.restore();
      }

      // ストローク描画（移動/スケール適用）
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
        // ブルーハロ
        ctx.strokeStyle = 'rgba(59, 130, 246, 0.4)';
        ctx.lineWidth = (sp ? stroke.width * Math.min(sp.sx, sp.sy) : stroke.width) + 4 / transform.scale;
        ctx.stroke(new Path2D(stroke.path));
        ctx.restore();
      }

      // バウンディングボックス + ハンドル描画
      if (bMinX !== Infinity) {
        const pad = 6 / transform.scale;

        // 変換後の bbox を計算
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

        // 破線ボックス
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 1.5 / transform.scale;
        ctx.setLineDash([6 / transform.scale, 4 / transform.scale]);
        ctx.strokeRect(rx, ry, rw, rh);
        ctx.setLineDash([]);

        // 8 ハンドル（共通関数）
        const hs = 4 / transform.scale;
        const midX = rx + rw / 2, midY = ry + rh / 2;
        drawResizeHandles(ctx, transform.scale, hs, rx, ry, rx + rw, ry + rh, midX, midY);
      }
      ctx.restore();
    }

    // 投げ縄: パス描画中
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

    // 固定サイズキャンバスの枠線
    if (canvasSize) {
      ctx.strokeStyle = '#9ca3af';
      ctx.lineWidth = 1 / transform.scale;
      ctx.setLineDash([]);
      ctx.strokeRect(0, 0, canvasSize.width, canvasSize.height);
    }

    ctx.restore();

    // 他ユーザーのカーソル描画（変換後座標）
    ctx.save();
    ctx.scale(dpr, dpr);
    
    for (const cursor of cursors.values()) {
      const screenX = cursor.x * transform.scale + transform.x;
      const screenY = cursor.y * transform.scale + transform.y;
      
      // カーソル（矢印風）
      ctx.fillStyle = cursor.color;
      ctx.beginPath();
      ctx.moveTo(screenX, screenY);
      ctx.lineTo(screenX + 12, screenY + 10);
      ctx.lineTo(screenX + 6, screenY + 10);
      ctx.lineTo(screenX + 6, screenY + 16);
      ctx.lineTo(screenX, screenY + 12);
      ctx.closePath();
      ctx.fill();
      
      // 名前ラベル
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillStyle = cursor.color;
      ctx.fillText(cursor.name, screenX + 14, screenY + 14);
    }
    
    ctx.restore();
  }, [activeStrokes, activeOverlays, overlayDisplayStates, overlayAssetTypes, overlayOpacityOverrides, selectedOverlayId, dragPreview, currentStroke, transform, cursors, drawLoadingOverlay, drawSpinner, canvasSize, backgroundConfig, lassoPath, lassoSelectedIds, lassoSelectedOverlayIds, lassoDragOffset, lassoScalePreview]);

  // 描画ループ
  useEffect(() => {
    let animationId: number;
    const loop = () => {
      render();
      animationId = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(animationId);
  }, [render]);

  // 画面座標 → キャンバス座標変換
  const screenToCanvas = useCallback((screenX: number, screenY: number): Point => {
    const container = containerRef.current;
    if (!container) return { x: screenX, y: screenY };

    const rect = container.getBoundingClientRect();
    const x = (screenX - rect.left - transform.x) / transform.scale;
    const y = (screenY - rect.top - transform.y) / transform.scale;
    return { x, y };
  }, [transform]);

  // 消しゴム処理 - パス接触判定
  const eraseAtPoint = useCallback((point: Point) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const eraserRadius = strokeWidth + 5;
    const strokesToErase: DrawEvent[] = [];

    for (const stroke of activeStrokes) {
      // まずBBoxで大まかにフィルタ（パフォーマンス最適化）
      if (!isPointInBBox(point.x, point.y, stroke.bbox, eraserRadius)) {
        continue;
      }

      // 曲線との正確な接触判定
      const path = new Path2D(stroke.path);
      
      // ストロークの太さを考慮した判定
      ctx.lineWidth = stroke.width + eraserRadius * 2;
      
      if (ctx.isPointInStroke(path, point.x, point.y)) {
        strokesToErase.push(stroke);
      }
    }

    if (strokesToErase.length > 0) {
      onEraseStrokes(strokesToErase);
    }
  }, [activeStrokes, strokeWidth, sessionId, onEraseStrokes]);

  // ポインタダウン
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.setPointerCapture(e.pointerId);
    
    // ポインタを追跡
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    
    // 前のドラッグ状態をクリア
    dragModeRef.current = 'none';
    dragStartRef.current = null;
    dragOverlayInitialRef.current = null;
    setDragPreview(null);
    
    // 2本指でピンチ/パンモード
    if (pointersRef.current.size === 2) {
      const points = Array.from(pointersRef.current.values());
      const dist = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
      lastPinchDistRef.current = dist;
      lastPanPointRef.current = {
        x: (points[0].x + points[1].x) / 2,
        y: (points[0].y + points[1].y) / 2,
      };
      isPanningRef.current = true;
      return;
    }
    
    const point = screenToCanvas(e.clientX, e.clientY);

    if (tool === 'pan') {
      isPanningRef.current = true;
      lastPanPointRef.current = { x: e.clientX, y: e.clientY };
      return;
    }

    if (tool === 'select') {
      // 選択中のオーバーレイがあればハンドルチェック
      if (selectedOverlayId) {
        const selectedOverlay = activeOverlays.find(o => o.overlayId === selectedOverlayId);
        if (selectedOverlay) {
          const handleSize = 12 / transform.scale;
          const midX = selectedOverlay.x + selectedOverlay.width / 2;
          const midY = selectedOverlay.y + selectedOverlay.height / 2;
          const handles: { mode: DragMode; hx: number; hy: number }[] = [
            { mode: 'resize-nw', hx: selectedOverlay.x, hy: selectedOverlay.y },
            { mode: 'resize-ne', hx: selectedOverlay.x + selectedOverlay.width, hy: selectedOverlay.y },
            { mode: 'resize-se', hx: selectedOverlay.x + selectedOverlay.width, hy: selectedOverlay.y + selectedOverlay.height },
            { mode: 'resize-sw', hx: selectedOverlay.x, hy: selectedOverlay.y + selectedOverlay.height },
            { mode: 'resize-n', hx: midX, hy: selectedOverlay.y },
            { mode: 'resize-s', hx: midX, hy: selectedOverlay.y + selectedOverlay.height },
            { mode: 'resize-w', hx: selectedOverlay.x, hy: midY },
            { mode: 'resize-e', hx: selectedOverlay.x + selectedOverlay.width, hy: midY },
          ];
          
          for (const handle of handles) {
            if (
              Math.abs(point.x - handle.hx) < handleSize &&
              Math.abs(point.y - handle.hy) < handleSize
            ) {
              dragModeRef.current = handle.mode;
              dragStartRef.current = point;
              dragOverlayInitialRef.current = {
                x: selectedOverlay.x,
                y: selectedOverlay.y,
                width: selectedOverlay.width,
                height: selectedOverlay.height,
                rotation: selectedOverlay.rotation,
              };
              return;
            }
          }
          
          // オーバーレイ内をクリック → 移動開始
          if (
            point.x >= selectedOverlay.x &&
            point.x <= selectedOverlay.x + selectedOverlay.width &&
            point.y >= selectedOverlay.y &&
            point.y <= selectedOverlay.y + selectedOverlay.height
          ) {
            dragModeRef.current = 'move';
            dragStartRef.current = point;
            dragOverlayInitialRef.current = {
              x: selectedOverlay.x,
              y: selectedOverlay.y,
              width: selectedOverlay.width,
              height: selectedOverlay.height,
              rotation: selectedOverlay.rotation,
            };
            return;
          }
        }
      }
      
      // オーバーレイをクリックしたかチェック（z-indexが高い順）
      let foundOverlay: OverlayState | null = null;
      for (let i = activeOverlays.length - 1; i >= 0; i--) {
        const overlay = activeOverlays[i];
        if (
          point.x >= overlay.x &&
          point.x <= overlay.x + overlay.width &&
          point.y >= overlay.y &&
          point.y <= overlay.y + overlay.height
        ) {
          foundOverlay = overlay;
          break;
        }
      }
      onSelectOverlay(foundOverlay?.overlayId ?? null);
      return;
    }

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

    if (tool === 'eraser') {
      eraseAtPoint(point);
    }

    if (tool === 'lasso') {
      // 選択済みストローク/オーバーレイがある場合
      if (lassoSelectedIds.size > 0 || lassoSelectedOverlayIds.size > 0) {
        const selStrokes = activeStrokes.filter(s => lassoSelectedIds.has(s.id));
        let bMinX = Infinity, bMinY = Infinity, bMaxX = -Infinity, bMaxY = -Infinity;
        for (const s of selStrokes) {
          if (s.bbox) {
            bMinX = Math.min(bMinX, s.bbox[0]); bMinY = Math.min(bMinY, s.bbox[1]);
            bMaxX = Math.max(bMaxX, s.bbox[2]); bMaxY = Math.max(bMaxY, s.bbox[3]);
          }
        }
        for (const ov of activeOverlays) {
          if (!lassoSelectedOverlayIds.has(ov.overlayId)) continue;
          bMinX = Math.min(bMinX, ov.x); bMinY = Math.min(bMinY, ov.y);
          bMaxX = Math.max(bMaxX, ov.x + ov.width); bMaxY = Math.max(bMaxY, ov.y + ov.height);
        }
        if (bMinX !== Infinity) {
          const pad = 6 / transform.scale;
          const bx0 = bMinX - pad, by0 = bMinY - pad;
          const bx1 = bMaxX + pad, by1 = bMaxY + pad;
          const handleHit = 12 / transform.scale;
          const midX = (bx0 + bx1) / 2, midY = (by0 + by1) / 2;

          // 8 ハンドルの判定
          const handles: { mode: LassoResizeMode; hx: number; hy: number }[] = [
            { mode: 'resize-nw', hx: bx0, hy: by0 },
            { mode: 'resize-ne', hx: bx1, hy: by0 },
            { mode: 'resize-se', hx: bx1, hy: by1 },
            { mode: 'resize-sw', hx: bx0, hy: by1 },
            { mode: 'resize-n',  hx: midX, hy: by0 },
            { mode: 'resize-s',  hx: midX, hy: by1 },
            { mode: 'resize-w',  hx: bx0, hy: midY },
            { mode: 'resize-e',  hx: bx1, hy: midY },
          ];
          for (const h of handles) {
            if (Math.abs(point.x - h.hx) < handleHit && Math.abs(point.y - h.hy) < handleHit) {
              lassoResizeModeRef.current = h.mode;
              lassoDragStartRef.current = point;
              lassoInitialBboxRef.current = [bMinX, bMinY, bMaxX, bMaxY];
              return;
            }
          }

          // bbox 内クリック → 移動
          if (point.x >= bx0 && point.x <= bx1 && point.y >= by0 && point.y <= by1) {
            lassoResizeModeRef.current = 'move';
            lassoDragStartRef.current = point;
            lassoInitialBboxRef.current = [bMinX, bMinY, bMaxX, bMaxY];
            return;
          }
        }
        // bbox 外クリック → 選択解除して新規投げ縄開始
        setLassoSelectedIds(new Set());
        setLassoSelectedOverlayIds(new Set());
        setLassoScalePreview(null);
      }
      // 投げ縄パス描画開始
      lassoPathRef.current = [point];
      setLassoPath([point]);
    }
  }, [tool, color, strokeWidth, screenToCanvas, eraseAtPoint, activeOverlays, activeStrokes, selectedOverlayId, transform.scale, onSelectOverlay, lassoSelectedIds, lassoSelectedOverlayIds]);

  // ポインタ移動
  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    // ポインタ位置を更新
    if (pointersRef.current.has(e.pointerId)) {
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    
    // 2本指操作（ピンチズーム + パン）
    if (pointersRef.current.size === 2 && lastPinchDistRef.current !== null) {
      const points = Array.from(pointersRef.current.values());
      const newDist = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
      const center = {
        x: (points[0].x + points[1].x) / 2,
        y: (points[0].y + points[1].y) / 2,
      };
      
      // ズーム
      const scaleFactor = newDist / lastPinchDistRef.current;
      const newScale = Math.max(0.1, Math.min(5, transform.scale * scaleFactor));
      
      // パン
      const dx = lastPanPointRef.current ? center.x - lastPanPointRef.current.x : 0;
      const dy = lastPanPointRef.current ? center.y - lastPanPointRef.current.y : 0;
      
      // ズーム中心点を考慮した変換
      const scaleChange = newScale / transform.scale;
      const newX = center.x - (center.x - transform.x) * scaleChange + dx;
      const newY = center.y - (center.y - transform.y) * scaleChange + dy;
      
      setTransform({ x: newX, y: newY, scale: newScale });
      
      lastPinchDistRef.current = newDist;
      lastPanPointRef.current = center;
      return;
    }
    
    const point = screenToCanvas(e.clientX, e.clientY);
    
    // カーソル位置を共有
    onUpdateCursor(point.x, point.y);

    if (tool === 'pan' && isPanningRef.current && lastPanPointRef.current) {
      const dx = e.clientX - lastPanPointRef.current.x;
      const dy = e.clientY - lastPanPointRef.current.y;
      setTransform((prev: CanvasTransform) => ({
        ...prev,
        x: prev.x + dx,
        y: prev.y + dy,
      }));
      lastPanPointRef.current = { x: e.clientX, y: e.clientY };
      return;
    }

    // オーバーレイのドラッグ処理
    if (tool === 'select' && dragModeRef.current !== 'none' && dragStartRef.current && dragOverlayInitialRef.current && selectedOverlayId) {
      const dx = point.x - dragStartRef.current.x;
      const dy = point.y - dragStartRef.current.y;
      const initial = dragOverlayInitialRef.current;
      
      if (dragModeRef.current === 'move') {
        // 移動
        setDragPreview({
          x: initial.x + dx,
          y: initial.y + dy,
          width: initial.width,
          height: initial.height,
        });
      } else {
        // リサイズ
        let newX = initial.x;
        let newY = initial.y;
        let newWidth = initial.width;
        let newHeight = initial.height;
        const aspectRatio = initial.width / initial.height;

        // AR ロック: overlayLockAspectRatios で false に設定されていなければ常にロック
        // （Shift キーで一時的に解除）
        const locked = !(overlayLockAspectRatios?.get(selectedOverlayId!) === false);
        const lockAR = locked ? !shiftPressed : shiftPressed;

        switch (dragModeRef.current) {
          case 'resize-nw':
            newX = initial.x + dx;
            newY = initial.y + dy;
            newWidth = initial.width - dx;
            newHeight = initial.height - dy;
            if (lockAR) {
              newHeight = newWidth / aspectRatio;
              newY = initial.y + initial.height - newHeight;
            }
            break;
          case 'resize-ne':
            newY = initial.y + dy;
            newWidth = initial.width + dx;
            newHeight = initial.height - dy;
            if (lockAR) {
              newHeight = newWidth / aspectRatio;
              newY = initial.y + initial.height - newHeight;
            }
            break;
          case 'resize-se':
            newWidth = initial.width + dx;
            newHeight = initial.height + dy;
            if (lockAR) {
              newHeight = newWidth / aspectRatio;
            }
            break;
          case 'resize-sw':
            newX = initial.x + dx;
            newWidth = initial.width - dx;
            newHeight = initial.height + dy;
            if (lockAR) {
              newHeight = newWidth / aspectRatio;
            }
            break;
          // 辺中央: 単軸のみ変更（AR ロック無視）
          case 'resize-n':
            newY = initial.y + dy;
            newHeight = initial.height - dy;
            break;
          case 'resize-s':
            newHeight = initial.height + dy;
            break;
          case 'resize-e':
            newWidth = initial.width + dx;
            break;
          case 'resize-w':
            newX = initial.x + dx;
            newWidth = initial.width - dx;
            break;
        }
        
        // 最小サイズを保証
        if (newWidth < 20) {
          if (dragModeRef.current === 'resize-nw' || dragModeRef.current === 'resize-sw' || dragModeRef.current === 'resize-w') {
            newX = initial.x + initial.width - 20;
          }
          newWidth = 20;
          if (lockAR && dragModeRef.current !== 'resize-w') {
            newHeight = newWidth / aspectRatio;
          }
        }
        if (newHeight < 20) {
          if (dragModeRef.current === 'resize-nw' || dragModeRef.current === 'resize-ne' || dragModeRef.current === 'resize-n') {
            newY = initial.y + initial.height - 20;
          }
          newHeight = 20;
          if (lockAR && dragModeRef.current !== 'resize-n') {
            newWidth = newHeight * aspectRatio;
          }
        }
        
        setDragPreview({ x: newX, y: newY, width: newWidth, height: newHeight });
      }
      return;
    }

    if (tool === 'pen' && activeStrokeRef.current) {
      activeStrokeRef.current.points.push({
        ...point,
        timestamp: Date.now(),
        pressure: e.pressure,
      });
      setCurrentStroke({ ...activeStrokeRef.current });
    }

    if (tool === 'eraser' && e.buttons > 0) {
      eraseAtPoint(point);
    }

    if (tool === 'lasso') {
      if (lassoDragStartRef.current && e.buttons > 0 && lassoInitialBboxRef.current) {
        const mode = lassoResizeModeRef.current;
        const dx = point.x - lassoDragStartRef.current.x;
        const dy = point.y - lassoDragStartRef.current.y;

        if (mode === 'move') {
          setLassoDragOffset({ x: dx, y: dy });
          setLassoScalePreview(null);
        } else if (mode !== 'none') {
          // リサイズ: bbox からスケール係数を計算
          const [bMinX, bMinY, bMaxX, bMaxY] = lassoInitialBboxRef.current;
          const bw = bMaxX - bMinX;
          const bh = bMaxY - bMinY;
          if (bw < 1 || bh < 1) return;

          let sx = 1, sy = 1, ox = bMinX, oy = bMinY;

          switch (mode) {
            // 四隅: AR 保持
            case 'resize-se': {
              const s = Math.max(0.05, (bw + dx) / bw);
              sx = sy = s; ox = bMinX; oy = bMinY;
              break;
            }
            case 'resize-sw': {
              const s = Math.max(0.05, (bw - dx) / bw);
              sx = sy = s; ox = bMaxX; oy = bMinY;
              break;
            }
            case 'resize-ne': {
              const s = Math.max(0.05, (bw + dx) / bw);
              sx = sy = s; ox = bMinX; oy = bMaxY;
              break;
            }
            case 'resize-nw': {
              const s = Math.max(0.05, (bw - dx) / bw);
              sx = sy = s; ox = bMaxX; oy = bMaxY;
              break;
            }
            // 辺中央: 単軸
            case 'resize-e': { sx = Math.max(0.05, (bw + dx) / bw); ox = bMinX; oy = bMinY; break; }
            case 'resize-w': { sx = Math.max(0.05, (bw - dx) / bw); ox = bMaxX; oy = bMinY; break; }
            case 'resize-s': { sy = Math.max(0.05, (bh + dy) / bh); ox = bMinX; oy = bMinY; break; }
            case 'resize-n': { sy = Math.max(0.05, (bh - dy) / bh); ox = bMinX; oy = bMaxY; break; }
          }
          setLassoScalePreview({ sx, sy, ox, oy });
          setLassoDragOffset(null);
        }
      } else if (lassoPathRef.current.length > 0 && e.buttons > 0) {
        // 投げ縄パス描画中
        lassoPathRef.current.push(point);
        setLassoPath([...lassoPathRef.current]);
      }
    }
  }, [tool, screenToCanvas, eraseAtPoint, onUpdateCursor, transform, selectedOverlayId, shiftPressed, overlayLockAspectRatios]);

  // ポインタアップ
  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.releasePointerCapture(e.pointerId);
    }
    
    // ポインタを削除
    pointersRef.current.delete(e.pointerId);
    
    // マルチタッチが終了した場合
    if (pointersRef.current.size < 2) {
      lastPinchDistRef.current = null;
    }

    if (isPanningRef.current) {
      isPanningRef.current = false;
      lastPanPointRef.current = null;
      return;
    }

    // オーバーレイドラッグ完了
    if (tool === 'select' && dragModeRef.current !== 'none' && dragOverlayInitialRef.current && selectedOverlayId && dragPreview) {
      const before = dragOverlayInitialRef.current;
      const selectedOverlay = activeOverlays.find(o => o.overlayId === selectedOverlayId);
      
      // 実際に移動/リサイズされた場合のみイベント発行
      if (
        dragPreview.x !== before.x ||
        dragPreview.y !== before.y ||
        dragPreview.width !== before.width ||
        dragPreview.height !== before.height
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

    if (tool === 'pen' && activeStrokeRef.current) {
      const stroke = activeStrokeRef.current;
      if (stroke.points.length >= 2) {
        // 曲線フィッティング
        const path = fitCurveToSvgPath(stroke.points, PRESETS.freehand);
        const bbox = calculateBBox(stroke.points);

        const event: DrawEvent = {
          type: 'D',
          timestamp: getTimestamp(),
          sessionId,
          id: stroke.id,
          color: stroke.color,
          width: stroke.width,
          bbox,
          path,
        };
        onAddDrawEvent(event);
      }

      activeStrokeRef.current = null;
      setCurrentStroke(null);
    }

    if (tool === 'lasso') {
      const mode = lassoResizeModeRef.current;
      const hasSelection = lassoSelectedIds.size > 0 || lassoSelectedOverlayIds.size > 0;
      if (lassoDragStartRef.current && hasSelection && mode !== 'none') {
        const originals = activeStrokes.filter(s => lassoSelectedIds.has(s.id));

        if (mode === 'move' && lassoDragOffset) {
          // 移動コミット
          const dx = lassoDragOffset.x;
          const dy = lassoDragOffset.y;
          if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
            const moved = originals.map(s => ({
              ...s,
              id: generateStrokeId(),
              timestamp: getTimestamp(),
              sessionId,
              path: offsetSvgPath(s.path, dx, dy),
              bbox: s.bbox ? [s.bbox[0] + dx, s.bbox[1] + dy, s.bbox[2] + dx, s.bbox[3] + dy] as [number, number, number, number] : s.bbox,
            }));
            // オーバーレイのデルタ
            const overlayDeltas: Array<{overlayId: string; dx: number; dy: number}> = [];
            for (const ov of activeOverlays) {
              if (lassoSelectedOverlayIds.has(ov.overlayId)) {
                overlayDeltas.push({ overlayId: ov.overlayId, dx, dy });
              }
            }
            onLassoMove?.(originals, moved, overlayDeltas);
            setLassoSelectedIds(new Set(moved.map(s => s.id)));
            // オーバーレイは ID が変わらないので維持
          }
        } else if (lassoScalePreview) {
          // リサイズコミット（ストロークのみ — オーバーレイのリサイズは未対応）
          const { sx, sy, ox, oy } = lassoScalePreview;
          if (Math.abs(sx - 1) > 0.001 || Math.abs(sy - 1) > 0.001) {
            const scaled = originals.map(s => ({
              ...s,
              id: generateStrokeId(),
              timestamp: getTimestamp(),
              sessionId,
              path: scaleSvgPath(s.path, sx, sy, ox, oy),
              width: s.width * Math.min(sx, sy),
              bbox: s.bbox ? [
                ox + (s.bbox[0] - ox) * sx,
                oy + (s.bbox[1] - oy) * sy,
                ox + (s.bbox[2] - ox) * sx,
                oy + (s.bbox[3] - oy) * sy,
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
            if (pointInPolygon(cx, cy, polygon)) {
              selected.add(stroke.id);
            }
          }
        }
        // オーバーレイも選択判定
        const selectedOvs = new Set<string>();
        for (const ov of activeOverlays) {
          const cx = ov.x + ov.width / 2;
          const cy = ov.y + ov.height / 2;
          if (pointInPolygon(cx, cy, polygon)) {
            selectedOvs.add(ov.overlayId);
          }
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
  }, [tool, sessionId, selectedOverlayId, activeOverlays, activeStrokes, dragPreview, onAddDrawEvent, onTransformOverlay, lassoSelectedIds, lassoSelectedOverlayIds, lassoDragOffset, lassoScalePreview, onLassoMove]);

  // ポインタ離脱
  const handlePointerLeave = useCallback((e: React.PointerEvent) => {
    // ポインタを削除
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) {
      lastPinchDistRef.current = null;
    }
    onHideCursor();
  }, [onHideCursor]);

  // ホイール（ズーム）— native listener で passive: false にするため useEffect で登録
  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
    const newScale = Math.max(0.1, Math.min(5, transform.scale * zoomFactor));

    // マウス位置を中心にズーム
    const scaleChange = newScale / transform.scale;
    const newX = mouseX - (mouseX - transform.x) * scaleChange;
    const newY = mouseY - (mouseY - transform.y) * scaleChange;

    setTransform({ x: newX, y: newY, scale: newScale });
  }, [transform]);

  // wheel イベントを non-passive で登録（React の onWheel は passive のため preventDefault 不可）
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  // キーボードイベント（Delete で選択削除）
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
  }, [selectedOverlayId, sessionId, onRemoveOverlay, onSelectOverlay, lassoSelectedIds, lassoSelectedOverlayIds, activeStrokes, onLassoDelete]);

  // ダブルクリックでオーバーレイを編集
  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    if (!onDoubleClickOverlay) return;
    if (tool !== 'select') return;
    
    const point = screenToCanvas(e.clientX, e.clientY);
    
    // オーバーレイをクリックしたかチェック（z-indexが高い順）
    for (let i = activeOverlays.length - 1; i >= 0; i--) {
      const overlay = activeOverlays[i];
      if (
        point.x >= overlay.x &&
        point.x <= overlay.x + overlay.width &&
        point.y >= overlay.y &&
        point.y <= overlay.y + overlay.height
      ) {
        onDoubleClickOverlay(overlay.overlayId);
        return;
      }
    }
  }, [tool, activeOverlays, screenToCanvas, onDoubleClickOverlay]);

  return (
    <div 
      ref={containerRef}
      style={{ 
        width: '100%', 
        height: '100%', 
        position: 'relative',
        cursor: getCursor(tool),
        touchAction: 'none', // タッチジェスチャーを無効化
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          touchAction: 'none', // キャンバス上でのスクロール等を無効化
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onDoubleClick={handleDoubleClick}
      />
    </div>
  );
}

// ========================================
// ヘルパー関数
// ========================================

function getCursor(tool: ToolType): string {
  switch (tool) {
    case 'pen': return 'crosshair';
    case 'eraser': return 'pointer';
    case 'pan': return 'grab';
    case 'select': return 'default';
    case 'lasso': return 'crosshair';
    default: return 'default';
  }
}

/**
 * 点が多角形の内部にあるかを判定（ray casting）
 */
function pointInPolygon(px: number, py: number, polygon: Point[]): boolean {
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
 * SVG パス文字列を (dx, dy) だけ平行移動する。
 * fitCurveToSvgPath が生成する M/C 絶対座標パスを想定。
 */
function offsetSvgPath(path: string, dx: number, dy: number): string {
  // 数値をすべてマッチし、x,y ペアずつオフセット
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
function scaleSvgPath(path: string, sx: number, sy: number, ox: number, oy: number): string {
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

/**
 * 8 つのリサイズハンドルを描画する（overlay select / lasso 共通）
 * 四隅: 白塗り正方形 + 青枠、辺中央: 白塗り長方形 + 青枠
 */
function drawResizeHandles(
  ctx: CanvasRenderingContext2D,
  scale: number,
  hs: number,
  x0: number, y0: number, x1: number, y1: number,
  midX: number, midY: number,
) {
  const blue = '#3b82f6';

  // 四隅: 青塗り正方形
  const corners = [
    { x: x0, y: y0 }, { x: x1, y: y0 },
    { x: x1, y: y1 }, { x: x0, y: y1 },
  ];
  ctx.fillStyle = blue;
  for (const c of corners) {
    ctx.fillRect(c.x - hs, c.y - hs, hs * 2, hs * 2);
  }

  // 辺中央: 細い青塗り長方形
  const thin = 2 / scale;   // 短辺
  const long = 8 / scale;   // 長辺
  ctx.fillStyle = blue;
  // n, s（横長）
  ctx.fillRect(midX - long, y0 - thin, long * 2, thin * 2);
  ctx.fillRect(midX - long, y1 - thin, long * 2, thin * 2);
  // w, e（縦長）
  ctx.fillRect(x0 - thin, midY - long, thin * 2, long * 2);
  ctx.fillRect(x1 - thin, midY - long, thin * 2, long * 2);
}

function drawBackground(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  transform: CanvasTransform,
  config?: BackgroundConfig
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
