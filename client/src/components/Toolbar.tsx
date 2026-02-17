import { useState, useCallback } from 'react';
import type { ToolType, StrokeWidthKey } from '../types';
import { COLOR_PALETTE, STROKE_WIDTHS } from '../types';

interface ToolbarProps {
  boardName: string;
  tool: ToolType;
  color: string;
  strokeWidthKey: StrokeWidthKey;
  canUndo?: boolean;
  canRedo?: boolean;
  isConnected?: boolean;
  peerCount?: number;
  hasContent?: boolean;
  hasAssets?: boolean;
  onBack: () => void;
  onToolChange: (tool: ToolType) => void;
  onColorChange: (color: string) => void;
  onStrokeWidthChange: (key: StrokeWidthKey) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onCopyShareLink?: () => void;
  onExportWbelx?: () => void;
  onExportSnapshot?: () => void;
  onAddAsset?: (uuid: string) => void;
  availableAssets?: Array<{ uuid: string; fileName: string; type: 'image' | 'document' | 'board' }>;
}

export function Toolbar({
  boardName,
  tool,
  color,
  strokeWidthKey,
  canUndo = false,
  canRedo = false,
  isConnected = false,
  peerCount = 0,
  hasContent = false,
  hasAssets = false,
  onBack,
  onToolChange,
  onColorChange,
  onStrokeWidthChange,
  onUndo,
  onRedo,
  onCopyShareLink,
  onExportWbelx,
  onExportSnapshot,
  onAddAsset,
  availableAssets = [],
}: ToolbarProps) {
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showAssetMenu, setShowAssetMenu] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  const handleCopyLink = useCallback(() => {
    onCopyShareLink?.();
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  }, [onCopyShareLink]);

  return (
    <div className="editor-toolbar">
      <button className="toolbar-back" onClick={onBack} title="Back to dashboard">
        ←
      </button>
      
      <span className="toolbar-title">{boardName}</span>

      {/* Tool selection */}
      <div className="toolbar-group">
        <button
          className={`toolbar-btn ${tool === 'select' ? 'active' : ''}`}
          onClick={() => onToolChange('select')}
          title="Select (V)"
        >
          🔲
        </button>
        <button
          className={`toolbar-btn ${tool === 'pen' ? 'active' : ''}`}
          onClick={() => onToolChange('pen')}
          title="Pen (P)"
        >
          ✏️
        </button>
        <button
          className={`toolbar-btn ${tool === 'eraser' ? 'active' : ''}`}
          onClick={() => onToolChange('eraser')}
          title="Eraser (E)"
        >
          🧹
        </button>
        <button
          className={`toolbar-btn ${tool === 'pan' ? 'active' : ''}`}
          onClick={() => onToolChange('pan')}
          title="Pan (Space)"
        >
          ✋
        </button>
      </div>

      <div className="toolbar-divider" />

      {/* Add Asset */}
      <div style={{ position: 'relative' }}>
        <button
          className="toolbar-btn"
          onClick={() => setShowAssetMenu(!showAssetMenu)}
          disabled={!hasAssets}
          title="Add asset to board"
        >
          🖼️
        </button>
        {showAssetMenu && availableAssets.length > 0 && (
          <>
            <div 
              className="dropdown-backdrop"
              onClick={() => setShowAssetMenu(false)}
            />
            <div className="dropdown-menu asset-dropdown">
              {/* Images */}
              {availableAssets.filter(a => a.type === 'image').length > 0 && (
                <>
                  <div className="dropdown-section-header">Images</div>
                  {availableAssets.filter(a => a.type === 'image').map((asset) => (
                    <button
                      key={asset.uuid}
                      className="dropdown-item"
                      onClick={() => {
                        onAddAsset?.(asset.uuid);
                        setShowAssetMenu(false);
                      }}
                    >
                      🖼️ {asset.fileName}
                    </button>
                  ))}
                </>
              )}
              {/* Boards */}
              {availableAssets.filter(a => a.type === 'board').length > 0 && (
                <>
                  <div className="dropdown-section-header">Boards</div>
                  {availableAssets.filter(a => a.type === 'board').map((asset) => (
                    <button
                      key={asset.uuid}
                      className="dropdown-item"
                      onClick={() => {
                        onAddAsset?.(asset.uuid);
                        setShowAssetMenu(false);
                      }}
                    >
                      📋 {asset.fileName}
                    </button>
                  ))}
                </>
              )}
              {/* Documents (PDF) */}
              {availableAssets.filter(a => a.type === 'document').length > 0 && (
                <>
                  <div className="dropdown-section-header">Documents</div>
                  {availableAssets.filter(a => a.type === 'document').map((asset) => (
                    <button
                      key={asset.uuid}
                      className="dropdown-item"
                      onClick={() => {
                        onAddAsset?.(asset.uuid);
                        setShowAssetMenu(false);
                      }}
                    >
                      📄 {asset.fileName}
                    </button>
                  ))}
                </>
              )}
              {availableAssets.length === 0 && (
                <div className="dropdown-item" style={{ color: '#888' }}>
                  No assets available
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <div className="toolbar-divider" />

      {/* Undo/Redo */}
      <div className="toolbar-group">
        <button
          className="toolbar-btn"
          onClick={onUndo}
          disabled={!canUndo}
          title="Undo (Ctrl+Z)"
        >
          ↩️
        </button>
        <button
          className="toolbar-btn"
          onClick={onRedo}
          disabled={!canRedo}
          title="Redo (Ctrl+Shift+Z)"
        >
          ↪️
        </button>
      </div>

      <div className="toolbar-divider" />

      {/* Stroke width */}
      <div className="toolbar-group">
        {(Object.keys(STROKE_WIDTHS) as StrokeWidthKey[]).map((key) => (
          <button
            key={key}
            className={`toolbar-btn ${strokeWidthKey === key ? 'active' : ''}`}
            onClick={() => onStrokeWidthChange(key)}
            title={`${key} (${key === 'thin' ? '1' : key === 'medium' ? '2' : '3'})`}
          >
            <svg width="20" height="20" viewBox="0 0 20 20">
              <circle 
                cx="10" 
                cy="10" 
                r={key === 'thin' ? 2 : key === 'medium' ? 4 : 6}
                fill="currentColor"
              />
            </svg>
          </button>
        ))}
      </div>

      <div className="toolbar-divider" />

      {/* Color picker */}
      <div className="color-picker">
        {COLOR_PALETTE.map((c) => (
          <button
            key={c}
            className={`color-swatch ${color === c ? 'active' : ''}`}
            style={{ backgroundColor: c }}
            onClick={() => onColorChange(c)}
            title={c}
          />
        ))}
      </div>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Share button */}
      <button
        className="toolbar-action-btn"
        onClick={handleCopyLink}
        title="Copy share link"
      >
        {linkCopied ? '✓ Copied!' : '🔗 Share'}
      </button>

      {/* Export dropdown */}
      <div style={{ position: 'relative' }}>
        <button
          className="toolbar-action-btn"
          onClick={() => setShowExportMenu(!showExportMenu)}
          disabled={!hasContent}
          title="Export board"
        >
          📥 Export
        </button>
        {showExportMenu && (
          <>
            <div 
              className="dropdown-backdrop"
              onClick={() => setShowExportMenu(false)}
            />
            <div className="dropdown-menu">
              <button
                className="dropdown-item"
                onClick={() => {
                  onExportWbelx?.();
                  setShowExportMenu(false);
                }}
              >
                📄 Download .wbelx (full history)
              </button>
              <button
                className="dropdown-item"
                onClick={() => {
                  onExportSnapshot?.();
                  setShowExportMenu(false);
                }}
              >
                📸 Download .snap.wbelx (snapshot)
              </button>
            </div>
          </>
        )}
      </div>

      <div className="toolbar-divider" />

      {/* Connection status */}
      <div className="connection-status">
        <span 
          className={`status-dot ${isConnected ? 'connected' : 'connecting'}`} 
        />
        <span>
          {isConnected 
            ? peerCount > 0 
              ? `${peerCount + 1} users` 
              : 'Connected'
            : 'Connecting...'
          }
        </span>
      </div>
    </div>
  );
}
