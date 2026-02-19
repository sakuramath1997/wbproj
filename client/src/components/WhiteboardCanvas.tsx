import { useRef, useEffect, useState, useCallback } from 'react';
import type { 
  ToolType, 
  Point, 
  ActiveStroke, 
  CanvasTransform, 
  DrawEvent,
  EraseEvent,
  CursorInfo,
  OverlayState,
  OverlayRemoveEvent,
  OverlayTransformEvent,
  AssetType,
} from '../types';
import { 
  calculateBBox, 
  generateStrokeId,
  generateEraseId,
  getTimestamp,
  isPointInBBox,
  fitCurveToSvgPath,
  PRESETS,
} from '../utils';

// ドラッグ状態の型
type DragMode = 'none' | 'move' | 'resize-nw' | 'resize-ne' | 'resize-se' | 'resize-sw';

interface WhiteboardCanvasProps {
  activeStrokes: DrawEvent[];
  activeOverlays: OverlayState[];
  cursors: Map<string, CursorInfo>;
  tool: ToolType;
  color: string;
  strokeWidth: number;
  sessionId: string;
  selectedOverlayId: string | null;
  overlayImages: Map<string, HTMLImageElement>;
  overlayAssetTypes: Map<string, AssetType>;
  /** ドラッグ中のリアルタイム透明度プレビュー用（overlayId → opacity） */
  overlayOpacityOverrides?: Map<string, number>;
  /** AR ロック設定（overlayId → locked, デフォルト true） */
  overlayLockAspectRatios?: Map<string, boolean>;
  /** 再生成中の overlayId セット（スピナー表示用） */
  loadingOverlayIds?: Set<string>;
  onAddDrawEvent: (event: DrawEvent) => void;
  onAddEraseEvent: (event: EraseEvent, targetStrokes: DrawEvent[]) => void;
  onRemoveOverlayEvent: (event: OverlayRemoveEvent) => void;
  onTransformOverlay: (event: OverlayTransformEvent, before: { x: number; y: number; width: number; height: number; rotation: number }) => void;
  onSelectOverlay: (overlayId: string | null) => void;
  onDoubleClickOverlay?: (overlayId: string) => void;
  onUpdateCursor: (x: number, y: number) => void;
  onHideCursor: () => void;
  onTransformChange?: (transform: CanvasTransform) => void;
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
  overlayImages,
  overlayAssetTypes,
  overlayOpacityOverrides,
  overlayLockAspectRatios,
  loadingOverlayIds,
  onAddDrawEvent,
  onAddEraseEvent,
  onRemoveOverlayEvent,
  onTransformOverlay,
  onSelectOverlay,
  onDoubleClickOverlay,
  onUpdateCursor,
  onHideCursor,
  onTransformChange,
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
    ctx.fillStyle = '#f8f9fa';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 変換適用
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.scale, transform.scale);
    
    // グリッド描画
    drawGrid(ctx, canvas.width / dpr, canvas.height / dpr, transform);

    // オーバーレイ描画（ストロークより後ろ）
    for (const overlay of activeOverlays) {
      ctx.save();
      ctx.globalAlpha = overlayOpacityOverrides?.get(overlay.overlayId) ?? overlay.opacity;
      
      // ドラッグ中は dragPreview の位置を使用
      const isBeingDragged = selectedOverlayId === overlay.overlayId && dragPreview;
      const displayX = isBeingDragged ? dragPreview.x : overlay.x;
      const displayY = isBeingDragged ? dragPreview.y : overlay.y;
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
      
      const img = overlayImages.get(overlay.overlayId);
      const isLoading = loadingOverlayIds?.has(overlay.overlayId) ?? false;

      if (img && img.complete) {
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
        if (isLoading) {
          drawLoadingOverlay(ctx, displayX, displayY, displayWidth, displayHeight, transform.scale, true);
        }
      } else {
        // 画像なし（初回読み込み or 再生成待ち）
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
        
        // 選択ハンドル
        const handleSize = 8 / transform.scale;
        ctx.fillStyle = '#3b82f6';
        const corners = [
          { x: displayX, y: displayY },
          { x: displayX + displayWidth, y: displayY },
          { x: displayX + displayWidth, y: displayY + displayHeight },
          { x: displayX, y: displayY + displayHeight },
        ];
        for (const corner of corners) {
          ctx.fillRect(
            corner.x - handleSize / 2,
            corner.y - handleSize / 2,
            handleSize,
            handleSize
          );
        }
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
  }, [activeStrokes, activeOverlays, overlayImages, overlayAssetTypes, overlayOpacityOverrides, loadingOverlayIds, selectedOverlayId, dragPreview, currentStroke, transform, cursors, drawLoadingOverlay, drawSpinner]);

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
      const event: EraseEvent = {
        type: 'E',
        timestamp: getTimestamp(),
        sessionId,
        id: generateEraseId(),
        targetIds: strokesToErase.map(s => s.id),
      };
      onAddEraseEvent(event, strokesToErase);
    }
  }, [activeStrokes, strokeWidth, sessionId, onAddEraseEvent]);

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
          const corners = [
            { mode: 'resize-nw' as DragMode, x: selectedOverlay.x, y: selectedOverlay.y },
            { mode: 'resize-ne' as DragMode, x: selectedOverlay.x + selectedOverlay.width, y: selectedOverlay.y },
            { mode: 'resize-se' as DragMode, x: selectedOverlay.x + selectedOverlay.width, y: selectedOverlay.y + selectedOverlay.height },
            { mode: 'resize-sw' as DragMode, x: selectedOverlay.x, y: selectedOverlay.y + selectedOverlay.height },
          ];
          
          for (const corner of corners) {
            if (
              Math.abs(point.x - corner.x) < handleSize &&
              Math.abs(point.y - corner.y) < handleSize
            ) {
              // リサイズ開始
              dragModeRef.current = corner.mode;
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
  }, [tool, color, strokeWidth, screenToCanvas, eraseAtPoint, activeOverlays, selectedOverlayId, transform.scale, onSelectOverlay]);

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
      setTransform(prev => ({
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
        }
        
        // 最小サイズを保証
        if (newWidth < 20) {
          if (dragModeRef.current === 'resize-nw' || dragModeRef.current === 'resize-sw') {
            newX = initial.x + initial.width - 20;
          }
          newWidth = 20;
          if (lockAR) {
            newHeight = newWidth / aspectRatio;
          }
        }
        if (newHeight < 20) {
          if (dragModeRef.current === 'resize-nw' || dragModeRef.current === 'resize-ne') {
            newY = initial.y + initial.height - 20;
          }
          newHeight = 20;
          if (lockAR) {
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
  }, [tool, screenToCanvas, eraseAtPoint, onUpdateCursor, transform]);

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
        const event: OverlayTransformEvent = {
          type: 'OT',
          timestamp: getTimestamp(),
          sessionId,
          overlayId: selectedOverlayId,
          x: dragPreview.x,
          y: dragPreview.y,
          width: dragPreview.width,
          height: dragPreview.height,
          rotation: selectedOverlay?.rotation ?? 0,
        };
        onTransformOverlay(event, before);
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
  }, [tool, sessionId, selectedOverlayId, activeOverlays, dragPreview, onAddDrawEvent, onTransformOverlay]);

  // ポインタ離脱
  const handlePointerLeave = useCallback((e: React.PointerEvent) => {
    // ポインタを削除
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) {
      lastPinchDistRef.current = null;
    }
    onHideCursor();
  }, [onHideCursor]);

  // ホイール（ズーム）
  const handleWheel = useCallback((e: React.WheelEvent) => {
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

  // キーボードイベント（Delete でオーバーレイ削除）
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedOverlayId) {
          const removeEvent: OverlayRemoveEvent = {
            type: 'OR',
            timestamp: getTimestamp(),
            sessionId,
            removeId: `r:${Date.now().toString(36)}`,
            targetOverlayIds: [selectedOverlayId],
          };
          onRemoveOverlayEvent(removeEvent);
          onSelectOverlay(null);
        }
      }
      if (e.key === 'Escape') {
        onSelectOverlay(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedOverlayId, sessionId, onRemoveOverlayEvent, onSelectOverlay]);

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
        onWheel={handleWheel}
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
    default: return 'default';
  }
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  transform: CanvasTransform
): void {
  const gridSize = 20;

  ctx.strokeStyle = '#e0e0e0';
  ctx.lineWidth = 1 / transform.scale;

  const startX = Math.floor(-transform.x / transform.scale / gridSize) * gridSize;
  const startY = Math.floor(-transform.y / transform.scale / gridSize) * gridSize;
  const endX = startX + width / transform.scale + gridSize * 2;
  const endY = startY + height / transform.scale + gridSize * 2;

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
}