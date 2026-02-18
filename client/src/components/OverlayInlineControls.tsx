/**
 * オーバーレイのインラインコントロール
 * 
 * 選択中のオーバーレイの下に表示される操作パネル
 */

import { useCallback } from 'react';
import type { OverlayState, AssetType } from '../types';

interface OverlayInlineControlsProps {
  overlay: OverlayState;
  assetType: AssetType;
  currentPage?: number;
  totalPages?: number;
  position: { x: number; y: number };
  scale: number;
  onPageChange?: (page: number) => void;
  onOpenEditor: () => void;
}

export function OverlayInlineControls({
  overlay,
  assetType,
  currentPage = 1,
  totalPages = 1,
  position,
  scale,
  onPageChange,
  onOpenEditor,
}: OverlayInlineControlsProps) {
  const handlePrevPage = useCallback(() => {
    if (currentPage > 1 && onPageChange) {
      onPageChange(currentPage - 1);
    }
  }, [currentPage, onPageChange]);

  const handleNextPage = useCallback(() => {
    if (currentPage < totalPages && onPageChange) {
      onPageChange(currentPage + 1);
    }
  }, [currentPage, totalPages, onPageChange]);

  // コントロールのスタイル（キャンバスの変換に合わせてスケール）
  const controlStyle: React.CSSProperties = {
    position: 'absolute',
    left: position.x,
    top: position.y + overlay.height * scale + 8,
    transform: 'translateX(-50%)',
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    background: 'rgba(255, 255, 255, 0.95)',
    borderRadius: '6px',
    padding: '4px 8px',
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
    zIndex: 1000,
    pointerEvents: 'auto',
  };

  const buttonStyle: React.CSSProperties = {
    background: 'none',
    border: 'none',
    padding: '4px 8px',
    cursor: 'pointer',
    fontSize: '14px',
    borderRadius: '4px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  };

  const disabledButtonStyle: React.CSSProperties = {
    ...buttonStyle,
    opacity: 0.3,
    cursor: 'not-allowed',
  };

  return (
    <div style={controlStyle} onClick={(e) => e.stopPropagation()}>
      {assetType === 'document' && totalPages > 1 && (
        <>
          <button
            style={currentPage <= 1 ? disabledButtonStyle : buttonStyle}
            onClick={handlePrevPage}
            disabled={currentPage <= 1}
            title="Previous page"
          >
            ◀
          </button>
          <span style={{ fontSize: '12px', minWidth: '50px', textAlign: 'center' }}>
            {currentPage} / {totalPages}
          </span>
          <button
            style={currentPage >= totalPages ? disabledButtonStyle : buttonStyle}
            onClick={handleNextPage}
            disabled={currentPage >= totalPages}
            title="Next page"
          >
            ▶
          </button>
          <div style={{ width: '1px', height: '16px', background: '#ddd', margin: '0 4px' }} />
        </>
      )}
      <button
        style={buttonStyle}
        onClick={onOpenEditor}
        title="Edit viewport"
      >
        🔍
      </button>
    </div>
  );
}
