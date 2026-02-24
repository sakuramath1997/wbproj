/**
 * LassoActionBar
 *
 * 投げ縄で選択中のストローク/オーバーレイの BBox 下部に表示されるアクションバー。
 * コピー / 複製 / 削除 の3ボタンを提供する。
 */

import type { CanvasTransform } from '../types';

export interface LassoActionBarProps {
  /** 選択 BBox (canvas 座標) [minX, minY, maxX, maxY] */
  canvasBBox: [number, number, number, number];
  canvasTransform: CanvasTransform;
  onCopy: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

export function LassoActionBar({
  canvasBBox,
  canvasTransform,
  onCopy,
  onDuplicate,
  onDelete,
}: LassoActionBarProps) {
  const t = canvasTransform;
  const [bMinX, , bMaxX, bMaxY] = canvasBBox;
  const screenCenterX = ((bMinX + bMaxX) / 2) * t.scale + t.x;
  const screenBottom = bMaxY * t.scale + t.y;

  return (
    <div
      className="lasso-action-bar"
      style={{ left: screenCenterX, top: screenBottom + 14 }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        className="overlay-inline-btn"
        onClick={onCopy}
        title="コピー (Ctrl+C)"
      >
        📋 コピー
      </button>
      <div className="overlay-inline-divider" />
      <button
        className="overlay-inline-btn"
        onClick={onDuplicate}
        title="複製"
      >
        📑 複製
      </button>
      <div className="overlay-inline-divider" />
      <button
        className="overlay-inline-btn overlay-inline-btn--delete"
        onClick={onDelete}
        title="削除 (Delete)"
      >
        🗑 削除
      </button>
    </div>
  );
}
