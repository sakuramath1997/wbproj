/**
 * OverlayInlineControls
 *
 * 選択中のオーバーレイの下端中央に表示されるフローティングコントロール。
 * canvas 上ではなく canvas-container の上に DOM として absolute 配置する。
 *
 * タイプ別表示:
 *   image    : 透明度 / ViewportEditor（トリミング）/ 削除
 *   document : ページ切替 / 透明度 / ViewportEditor（トリミング）/ 削除
 *   board    : 透明度 / ViewportEditor（表示領域）/ 削除
 */

import { useState, useCallback, useRef } from 'react';
import type { OverlayState, AssetType, CanvasTransform } from '../types';

// ----------------------------------------------------------------
// Props
// ----------------------------------------------------------------

export interface OverlayInlineControlsProps {
  overlay: OverlayState;
  assetType: AssetType;
  canvasTransform: CanvasTransform;

  // PDF 専用
  pdfTotalPages: number;

  // z-order
  canBringForward: boolean;
  canSendBackward: boolean;
  onBringToFront: () => void;
  onBringForward: () => void;
  onSendBackward: () => void;
  onSendToBack: () => void;

  // コールバック
  onPageChange: (page: number) => void;
  /** スライダードラッグ中に呼ばれる（リアルタイムプレビュー用）*/
  onOpacityPreview: (opacity: number) => void;
  /** スライダーを離したときに呼ばれる。Undo スタックに乗る。 */
  onOpacityCommit: (opacity: number) => void;
  onOpenViewportEditor: () => void;
  onDelete: () => void;
}

// ----------------------------------------------------------------
// コンポーネント
// ----------------------------------------------------------------

export function OverlayInlineControls({
  overlay,
  assetType,
  canvasTransform,
  pdfTotalPages,
  canBringForward,
  canSendBackward,
  onBringToFront,
  onBringForward,
  onSendBackward,
  onSendToBack,
  onPageChange,
  onOpacityPreview,
  onOpacityCommit,
  onOpenViewportEditor,
  onDelete,
}: OverlayInlineControlsProps) {
  // opacity はドラッグ中だけローカル state でプレビュー
  const [localOpacity, setLocalOpacity] = useState(overlay.opacity);
  const opacityBeforeRef = useRef(overlay.opacity);

  // overlay.opacity が外から変わったとき（Undo/Redo）に同期
  // React recommended: adjust state during render instead of useEffect
  const [prevOverlayOpacity, setPrevOverlayOpacity] = useState(overlay.opacity);
  if (overlay.opacity !== prevOverlayOpacity) {
    setPrevOverlayOpacity(overlay.opacity);
    setLocalOpacity(overlay.opacity);
  }

  // ----------------------------------------------------------------
  // スクリーン座標の計算（canvasTransform からオーバーレイ下端中央を算出）
  // ----------------------------------------------------------------
  const t = canvasTransform;
  const screenCenterX = overlay.x * t.scale + t.x + (overlay.width  * t.scale) / 2;
  const screenBottom  = overlay.y * t.scale + t.y +  overlay.height * t.scale;

  // ----------------------------------------------------------------
  // ハンドラ
  // ----------------------------------------------------------------

  const handleOpacityMouseDown = useCallback(() => {
    opacityBeforeRef.current = overlay.opacity;
  }, [overlay.opacity]);

  const handleOpacityChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value) / 100;
    setLocalOpacity(v);
    onOpacityPreview(v);
  }, [onOpacityPreview]);

  const handleOpacityCommit = useCallback(() => {
    onOpacityCommit(localOpacity);
  }, [localOpacity, onOpacityCommit]);

  const handlePagePrev = useCallback(() => {
    if (overlay.page > 1) onPageChange(overlay.page - 1);
  }, [overlay.page, onPageChange]);

  const handlePageNext = useCallback(() => {
    if (overlay.page < pdfTotalPages) onPageChange(overlay.page + 1);
  }, [overlay.page, pdfTotalPages, onPageChange]);

  // ----------------------------------------------------------------
  // ラベル
  // ----------------------------------------------------------------
  const editorLabel =
    assetType === 'board' ? '表示領域…' : 'トリミング…';

  // ----------------------------------------------------------------
  // レンダリング
  // ----------------------------------------------------------------
  return (
    <div
      className="overlay-inline-controls"
      style={{ left: screenCenterX, top: screenBottom + 10 }}
      onPointerDown={(e: React.PointerEvent<HTMLDivElement>) => e.stopPropagation()}
      onClick={(e: React.MouseEvent<HTMLDivElement>) => e.stopPropagation()}
    >
      {/* PDF ページ切替 */}
      {assetType === 'document' && pdfTotalPages > 1 && (
        <>
          <div className="overlay-inline-group">
            <button
              className="overlay-inline-btn"
              onClick={handlePagePrev}
              disabled={overlay.page <= 1}
              title="前のページ"
            >◀</button>
            <span className="overlay-inline-page">
              {overlay.page} / {pdfTotalPages}
            </span>
            <button
              className="overlay-inline-btn"
              onClick={handlePageNext}
              disabled={overlay.page >= pdfTotalPages}
              title="次のページ"
            >▶</button>
          </div>
          <div className="overlay-inline-divider" />
        </>
      )}

      {/* 透明度 */}
      <div className="overlay-inline-group">
        <span className="overlay-inline-label">不透明度</span>
        <input
          type="range"
          className="overlay-inline-slider"
          min={0}
          max={100}
          step={1}
          value={Math.round(localOpacity * 100)}
          onMouseDown={handleOpacityMouseDown}
          onChange={handleOpacityChange}
          onMouseUp={handleOpacityCommit}
          onTouchEnd={handleOpacityCommit}
          title={`${Math.round(localOpacity * 100)}%`}
        />
        <span className="overlay-inline-value">
          {Math.round(localOpacity * 100)}%
        </span>
      </div>

      <div className="overlay-inline-divider" />

      {/* ViewportEditor を開く */}
      <button
        className="overlay-inline-btn overlay-inline-btn--editor"
        onClick={onOpenViewportEditor}
        title={editorLabel}
      >
        {assetType === 'board' ? '🗂' : '✂️'} {editorLabel}
      </button>

      <div className="overlay-inline-divider" />

      {/* z-order */}
      <div className="overlay-inline-group">
        <button
          className="overlay-inline-btn"
          onClick={onBringToFront}
          disabled={!canBringForward}
          title="最前面へ"
        >⤒</button>
        <button
          className="overlay-inline-btn"
          onClick={onBringForward}
          disabled={!canBringForward}
          title="前へ"
        >↑</button>
        <button
          className="overlay-inline-btn"
          onClick={onSendBackward}
          disabled={!canSendBackward}
          title="後ろへ"
        >↓</button>
        <button
          className="overlay-inline-btn"
          onClick={onSendToBack}
          disabled={!canSendBackward}
          title="最背面へ"
        >⤓</button>
      </div>

      <div className="overlay-inline-divider" />

      {/* 削除 */}
      <button
        className="overlay-inline-btn overlay-inline-btn--delete"
        onClick={onDelete}
        title="削除 (Delete キー)"
      >
        🗑
      </button>
    </div>
  );
}
