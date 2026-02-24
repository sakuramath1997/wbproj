import { useState, useCallback, useRef } from 'react';
import type { ToolType, StrokeWidthKey, BackgroundConfig, BackgroundPattern } from '../types';
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
  onBack: () => void;
  onToolChange: (tool: ToolType) => void;
  onColorChange: (color: string) => void;
  onStrokeWidthChange: (key: StrokeWidthKey) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onCopyShareLink?: () => void;
  onExportWbelx?: () => void;
  onExportSnapshot?: () => void;
  onExportPng?: () => void;
  onExportSvg?: () => void;
  onAddAsset?: (uuid: string) => void;
  onImportFile?: (file: File) => Promise<string | null>;
  availableAssets?: Array<{ uuid: string; fileName: string; type: 'image' | 'document' | 'board' }>;
  canvasSize?: { width: number; height: number };
  onCanvasSizeChange?: (width: number | undefined, height: number | undefined) => void;
  backgroundConfig?: BackgroundConfig;
  onBackgroundChange?: (config: BackgroundConfig) => void;
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
  onBack,
  onToolChange,
  onColorChange,
  onStrokeWidthChange,
  onUndo,
  onRedo,
  onCopyShareLink,
  onExportWbelx,
  onExportSnapshot,
  onExportPng,
  onExportSvg,
  onAddAsset,
  onImportFile,
  availableAssets = [],
  canvasSize,
  onCanvasSizeChange,
  backgroundConfig,
  onBackgroundChange,
}: ToolbarProps) {
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showAssetMenu, setShowAssetMenu] = useState(false);
  const [showCanvasSizeMenu, setShowCanvasSizeMenu] = useState(false);
  const [showBgMenu, setShowBgMenu] = useState(false);
  const [customWidth, setCustomWidth] = useState('');
  const [customHeight, setCustomHeight] = useState('');
  const [linkCopied, setLinkCopied] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const CANVAS_PRESETS = [
    { label: '∞ Infinite', w: undefined, h: undefined },
    { label: 'Full HD (1920×1080)', w: 1920, h: 1080 },
    { label: '4K (3840×2160)', w: 3840, h: 2160 },
    { label: 'A4 Landscape (1123×794)', w: 1123, h: 794 },
    { label: 'A4 Portrait (794×1123)', w: 794, h: 1123 },
    { label: 'Letter Landscape (1056×816)', w: 1056, h: 816 },
    { label: 'Square (1024×1024)', w: 1024, h: 1024 },
  ] as const;

  const handleCopyLink = useCallback(() => {
    onCopyShareLink?.();
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  }, [onCopyShareLink]);

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !onImportFile) return;
    
    setIsImporting(true);
    try {
      const uuid = await onImportFile(file);
      if (uuid) {
        // インポート成功したら即座にオーバーレイとして追加
        onAddAsset?.(uuid);
      }
    } finally {
      setIsImporting(false);
      setShowAssetMenu(false);
      // ファイル入力をリセット
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }, [onImportFile, onAddAsset]);

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
        <button
          className={`toolbar-btn ${tool === 'lasso' ? 'active' : ''}`}
          onClick={() => onToolChange('lasso')}
          title="Lasso (L)"
        >
          〇
        </button>
      </div>

      <div className="toolbar-divider" />

      {/* Add Asset */}
      <div style={{ position: 'relative' }}>
        <button
          className="toolbar-btn"
          onClick={() => setShowAssetMenu(!showAssetMenu)}
          disabled={isImporting}
          title="Add asset to board"
        >
          {isImporting ? '⏳' : '🖼️'}
        </button>
        {showAssetMenu && (
          <>
            <div 
              className="dropdown-backdrop"
              onClick={() => setShowAssetMenu(false)}
            />
            <div className="dropdown-menu asset-dropdown">
              {/* Import Section */}
              <div className="dropdown-section-header">Import New</div>
              <button
                className="dropdown-item"
                onClick={() => {
                  if (fileInputRef.current) {
                    fileInputRef.current.accept = 'image/*';
                    fileInputRef.current.click();
                  }
                }}
              >
                📷 Import Image...
              </button>
              <button
                className="dropdown-item"
                onClick={() => {
                  if (fileInputRef.current) {
                    fileInputRef.current.accept = 'application/pdf';
                    fileInputRef.current.click();
                  }
                }}
              >
                📄 Import PDF...
              </button>
              
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
            </div>
          </>
        )}
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          style={{ display: 'none' }}
          onChange={handleFileSelect}
        />
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

      {/* Canvas size */}
      {onCanvasSizeChange && (
        <div style={{ position: 'relative' }}>
          <button
            className="toolbar-action-btn"
            onClick={() => setShowCanvasSizeMenu(!showCanvasSizeMenu)}
            title="Canvas size"
          >
            📐 {canvasSize ? `${canvasSize.width}×${canvasSize.height}` : 'Infinite'}
          </button>
          {showCanvasSizeMenu && (
            <>
              <div 
                className="dropdown-backdrop"
                onClick={() => setShowCanvasSizeMenu(false)}
              />
              <div className="dropdown-menu" style={{ right: 0, minWidth: 220 }}>
                {CANVAS_PRESETS.map((preset, i) => {
                  const isActive = preset.w === undefined
                    ? !canvasSize
                    : canvasSize?.width === preset.w && canvasSize?.height === preset.h;
                  return (
                    <button
                      key={i}
                      className={`dropdown-item ${isActive ? 'active' : ''}`}
                      onClick={() => {
                        onCanvasSizeChange(preset.w, preset.h);
                        setShowCanvasSizeMenu(false);
                      }}
                    >
                      {isActive ? '✓ ' : ''}{preset.label}
                    </button>
                  );
                })}
                <div style={{ borderTop: '1px solid #e5e7eb', margin: '4px 0' }} />
                <div style={{ padding: '6px 12px' }}>
                  <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>Custom size</div>
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    <input
                      type="number"
                      placeholder="W"
                      value={customWidth}
                      onChange={e => setCustomWidth(e.target.value)}
                      style={{ width: 60, padding: '2px 4px', fontSize: 12, border: '1px solid #d1d5db', borderRadius: 3 }}
                      min={1}
                    />
                    <span style={{ fontSize: 12, color: '#9ca3af' }}>×</span>
                    <input
                      type="number"
                      placeholder="H"
                      value={customHeight}
                      onChange={e => setCustomHeight(e.target.value)}
                      style={{ width: 60, padding: '2px 4px', fontSize: 12, border: '1px solid #d1d5db', borderRadius: 3 }}
                      min={1}
                    />
                    <button
                      className="toolbar-btn"
                      style={{ fontSize: 12, padding: '2px 8px' }}
                      disabled={!customWidth || !customHeight || Number(customWidth) < 1 || Number(customHeight) < 1}
                      onClick={() => {
                        const w = Math.round(Number(customWidth));
                        const h = Math.round(Number(customHeight));
                        if (w > 0 && h > 0) {
                          onCanvasSizeChange(w, h);
                          setShowCanvasSizeMenu(false);
                          setCustomWidth('');
                          setCustomHeight('');
                        }
                      }}
                    >
                      Set
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* Background settings */}
      {onBackgroundChange && backgroundConfig && (
        <div style={{ position: 'relative' }}>
          <button
            className="toolbar-action-btn"
            onClick={() => setShowBgMenu(!showBgMenu)}
            title="Background settings"
          >
            <span style={{
              display: 'inline-block', width: 12, height: 12, borderRadius: 2,
              backgroundColor: backgroundConfig.color, border: '1px solid #9ca3af',
              verticalAlign: 'middle', marginRight: 4,
            }} />
            BG
          </button>
          {showBgMenu && (
            <>
              <div
                className="dropdown-backdrop"
                onClick={() => setShowBgMenu(false)}
              />
              <div className="dropdown-menu" style={{ right: 0, minWidth: 220, padding: '8px 12px' }}>
                {/* Background color */}
                <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>Background color</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                  <input
                    type="color"
                    value={backgroundConfig.color}
                    onChange={e => onBackgroundChange({ ...backgroundConfig, color: e.target.value })}
                    style={{ width: 28, height: 28, padding: 0, border: '1px solid #d1d5db', borderRadius: 4, cursor: 'pointer' }}
                  />
                  <input
                    type="text"
                    value={backgroundConfig.color}
                    onChange={e => {
                      const v = e.target.value;
                      if (/^#[0-9a-fA-F]{6}$/.test(v)) onBackgroundChange({ ...backgroundConfig, color: v });
                    }}
                    style={{ width: 72, padding: '2px 4px', fontSize: 12, border: '1px solid #d1d5db', borderRadius: 3, fontFamily: 'monospace' }}
                  />
                  {backgroundConfig.color !== '#ffffff' && (
                    <button
                      className="toolbar-btn"
                      style={{ fontSize: 11, padding: '2px 6px' }}
                      onClick={() => onBackgroundChange({ ...backgroundConfig, color: '#ffffff' })}
                      title="Reset to white"
                    >↺</button>
                  )}
                </div>

                {/* Pattern */}
                <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>Pattern</div>
                <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
                  {(['none', 'dots', 'grid', 'lines'] as BackgroundPattern[]).map(p => (
                    <button
                      key={p}
                      className={`toolbar-btn ${backgroundConfig.pattern === p ? 'active' : ''}`}
                      style={{
                        flex: 1, fontSize: 11, padding: '3px 0',
                        backgroundColor: backgroundConfig.pattern === p ? '#dbeafe' : undefined,
                        borderColor: backgroundConfig.pattern === p ? '#3b82f6' : undefined,
                      }}
                      onClick={() => onBackgroundChange({ ...backgroundConfig, pattern: p })}
                    >
                      {p === 'none' ? '—' : p === 'dots' ? '··' : p === 'grid' ? '⊞' : '∥'} {p}
                    </button>
                  ))}
                </div>

                {/* Pattern size & color (only when pattern != none) */}
                {backgroundConfig.pattern !== 'none' && (
                  <>
                    <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>Pattern size: {backgroundConfig.patternSize}px</div>
                    <input
                      type="range"
                      min={5}
                      max={100}
                      value={backgroundConfig.patternSize}
                      onChange={e => onBackgroundChange({ ...backgroundConfig, patternSize: Number(e.target.value) })}
                      style={{ width: '100%', marginBottom: 8 }}
                    />

                    <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>Pattern color</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                      <input
                        type="color"
                        value={backgroundConfig.patternColor}
                        onChange={e => onBackgroundChange({ ...backgroundConfig, patternColor: e.target.value })}
                        style={{ width: 28, height: 28, padding: 0, border: '1px solid #d1d5db', borderRadius: 4, cursor: 'pointer' }}
                      />
                      <input
                        type="text"
                        value={backgroundConfig.patternColor}
                        onChange={e => {
                          const v = e.target.value;
                          if (/^#[0-9a-fA-F]{6}$/.test(v)) onBackgroundChange({ ...backgroundConfig, patternColor: v });
                        }}
                        style={{ width: 72, padding: '2px 4px', fontSize: 12, border: '1px solid #d1d5db', borderRadius: 3, fontFamily: 'monospace' }}
                      />
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}

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
                  onExportPng?.();
                  setShowExportMenu(false);
                }}
              >
                🖼️ Download as PNG
              </button>
              <button
                className="dropdown-item"
                onClick={() => {
                  onExportSvg?.();
                  setShowExportMenu(false);
                }}
              >
                📐 Download as SVG
              </button>
              <hr style={{ margin: '4px 0', border: 'none', borderTop: '1px solid var(--border-light)' }} />
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
