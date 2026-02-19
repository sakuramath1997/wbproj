import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useProjectStore, type ImportedAsset } from '../hooks/useProjectStore';
import type { BoardInfo, BoardSortKey } from '../types';
import { sortBoards } from '../types';

type TabType = 'boards' | 'assets' | 'settings' | 'export';

export function ProjectDashboard() {
  const navigate = useNavigate();
  const { 
    project, 
    getBoards, 
    addBoard, 
    renameBoard, 
    deleteBoard, 
    renameProject, 
    save, 
    reorderBoards 
  } = useProjectStore();
  const [activeTab, setActiveTab] = useState<TabType>('boards');
  const [sortKey, setSortKey] = useState<BoardSortKey>('displayOrder');
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editingTitle, setEditingTitle] = useState('');

  // project の変更を検知するために project を依存配列に追加
  const boards = useMemo(() => {
    if (!project) return [];
    const allBoards = getBoards();
    return sortBoards(allBoards, sortKey);
  }, [project, getBoards, sortKey]);

  const handleBack = useCallback(() => {
    navigate('/');
  }, [navigate]);

  const handleAddBoard = useCallback(async () => {
    const name = prompt('Enter board name:', `Board ${boards.length + 1}`);
    if (name) {
      await addBoard(name);
    }
  }, [addBoard, boards.length]);

  const handleBoardClick = useCallback((boardId: string) => {
    navigate(`/project/board/${boardId}`);
  }, [navigate]);

  const handleExport = useCallback(async () => {
    const blob = await save();
    if (blob) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${project?.config.project.name || 'project'}.wbproj`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  }, [save, project]);

  const handleReorder = useCallback(async (orderedIds: string[]) => {
    await reorderBoards(orderedIds);
  }, [reorderBoards]);

  const handleRenameBoard = useCallback(async (boardId: string, currentName: string) => {
    const newName = prompt('Enter new board name:', currentName);
    if (newName && newName !== currentName) {
      await renameBoard(boardId, newName);
    }
  }, [renameBoard]);

  const handleDeleteBoard = useCallback(async (boardId: string, boardName: string) => {
    if (boards.length <= 1) {
      alert('Cannot delete the last board.');
      return;
    }
    if (confirm(`Delete "${boardName}"? This cannot be undone.`)) {
      await deleteBoard(boardId);
    }
  }, [deleteBoard, boards.length]);

  const handleTitleClick = useCallback(() => {
    if (project) {
      setEditingTitle(project.config.project.name);
      setIsEditingTitle(true);
    }
  }, [project]);

  const handleTitleSave = useCallback(async () => {
    if (editingTitle.trim()) {
      await renameProject(editingTitle.trim());
    }
    setIsEditingTitle(false);
  }, [editingTitle, renameProject]);

  const handleTitleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleTitleSave();
    } else if (e.key === 'Escape') {
      setIsEditingTitle(false);
    }
  }, [handleTitleSave]);

  if (!project) {
    navigate('/');
    return null;
  }

  return (
    <div className="dashboard">
      {/* Header */}
      <header className="dashboard-header">
        <button className="dashboard-back" onClick={handleBack}>
          ←
        </button>
        {isEditingTitle ? (
          <input
            type="text"
            className="dashboard-title-input"
            value={editingTitle}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditingTitle(e.target.value)}
            onBlur={handleTitleSave}
            onKeyDown={handleTitleKeyDown}
            autoFocus
          />
        ) : (
          <h1 
            className="dashboard-title editable" 
            onClick={handleTitleClick}
            title="Click to rename"
          >
            {project.config.project.name}
            <span className="edit-icon">✏️</span>
          </h1>
        )}
        <div className="dashboard-actions">
          <button className="dashboard-btn secondary" onClick={handleExport}>
            📥 Export
          </button>
          <button className="dashboard-btn primary" onClick={handleAddBoard}>
            ＋ New Board
          </button>
        </div>
      </header>

      {/* Tabs */}
      <nav className="dashboard-tabs">
        <button 
          className={`dashboard-tab ${activeTab === 'boards' ? 'active' : ''}`}
          onClick={() => setActiveTab('boards')}
        >
          Boards
        </button>
        <button 
          className={`dashboard-tab ${activeTab === 'assets' ? 'active' : ''}`}
          onClick={() => setActiveTab('assets')}
        >
          Assets
        </button>
        <button 
          className={`dashboard-tab ${activeTab === 'settings' ? 'active' : ''}`}
          onClick={() => setActiveTab('settings')}
        >
          Settings
        </button>
      </nav>

      {/* Content */}
      <div className="dashboard-content">
        {activeTab === 'boards' && (
          <BoardsTab 
            boards={boards}
            sortKey={sortKey}
            onSortChange={setSortKey}
            onBoardClick={handleBoardClick}
            onReorder={handleReorder}
            onRenameBoard={handleRenameBoard}
            onDeleteBoard={handleDeleteBoard}
          />
        )}
        {activeTab === 'assets' && <AssetsTab />}
        {activeTab === 'settings' && <SettingsTab />}
      </div>
    </div>
  );
}

// ========================================
// Boards Tab
// ========================================

interface BoardsTabProps {
  boards: BoardInfo[];
  sortKey: BoardSortKey;
  onSortChange: (key: BoardSortKey) => void;
  onBoardClick: (boardId: string) => void;
  onReorder: (orderedIds: string[]) => void;
  onRenameBoard: (boardId: string, currentName: string) => void;
  onDeleteBoard: (boardId: string, boardName: string) => void;
}

function BoardsTab({ 
  boards, 
  sortKey, 
  onSortChange, 
  onBoardClick, 
  onReorder,
  onRenameBoard,
  onDeleteBoard,
}: BoardsTabProps) {
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const dragCounterRef = useRef(0);

  const handleDragStart = useCallback((e: React.DragEvent<HTMLDivElement>, boardId: string) => {
    setDraggedId(boardId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', boardId);
    // ドラッグ中の要素を半透明に
    const target = e.currentTarget;
    setTimeout(() => {
      target.style.opacity = '0.5';
    }, 0);
  }, []);

  const handleDragEnd = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    setDraggedId(null);
    setDragOverId(null);
    dragCounterRef.current = 0;
    e.currentTarget.style.opacity = '1';
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>, boardId: string) => {
    e.preventDefault();
    dragCounterRef.current++;
    if (boardId !== draggedId) {
      setDragOverId(boardId);
    }
  }, [draggedId]);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setDragOverId(null);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>, targetId: string) => {
    e.preventDefault();
    setDragOverId(null);
    dragCounterRef.current = 0;

    if (!draggedId || draggedId === targetId) return;

    // 新しい順序を計算
    const currentIds = boards.map(b => b.id);
    const draggedIndex = currentIds.indexOf(draggedId);
    const targetIndex = currentIds.indexOf(targetId);

    if (draggedIndex === -1 || targetIndex === -1) return;

    // 配列から draggedId を削除し、targetId の位置に挿入
    const newIds = [...currentIds];
    newIds.splice(draggedIndex, 1);
    newIds.splice(targetIndex, 0, draggedId);

    onReorder(newIds);
    setDraggedId(null);
  }, [draggedId, boards, onReorder]);

  if (boards.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">📋</div>
        <h3 className="empty-state-title">No boards yet</h3>
        <p className="empty-state-message">
          Create a new board to get started
        </p>
      </div>
    );
  }

  const isDraggable = sortKey === 'displayOrder';

  return (
    <div>
      {/* Sort controls */}
      <div className="boards-toolbar">
        <span className="boards-toolbar-label">Sort by:</span>
        <select 
          value={sortKey} 
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onSortChange(e.target.value as BoardSortKey)}
          className="boards-sort-select"
        >
          <option value="displayOrder">Display Order</option>
          <option value="createdAt">Created Date</option>
          <option value="updatedAt">Updated Date</option>
          <option value="name">Name</option>
        </select>
        {isDraggable && (
          <span className="boards-drag-hint">
            ドラッグして並び替え
          </span>
        )}
      </div>

      {/* Board grid */}
      <div className="board-grid">
        {boards.map((board) => (
          <div 
            key={board.id}
            className={`board-card ${dragOverId === board.id ? 'drag-over' : ''} ${draggedId === board.id ? 'dragging' : ''}`}
            draggable={isDraggable}
            onDragStart={(e: React.DragEvent<HTMLDivElement>) => handleDragStart(e, board.id)}
            onDragEnd={handleDragEnd}
            onDragEnter={(e: React.DragEvent<HTMLDivElement>) => handleDragEnter(e, board.id)}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={(e: React.DragEvent<HTMLDivElement>) => handleDrop(e, board.id)}
            onClick={() => !draggedId && !menuOpenId && onBoardClick(board.id)}
          >
            {isDraggable && (
              <div className="board-drag-handle">⋮⋮</div>
            )}
            <button 
              className="board-menu-btn"
              onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
              }}
            >
              ⋯
            </button>
            {menuOpenId === board.id && (
              <div className="board-menu" onClick={(e: React.MouseEvent<HTMLDivElement>) => e.stopPropagation()}>
                <button 
                  className="board-menu-item"
                  onClick={() => {
                    setMenuOpenId(null);
                    onRenameBoard(board.id, board.name);
                  }}
                >
                  ✏️ Rename
                </button>
                <button 
                  className="board-menu-item danger"
                  onClick={() => {
                    setMenuOpenId(null);
                    onDeleteBoard(board.id, board.name);
                  }}
                >
                  🗑️ Delete
                </button>
              </div>
            )}
            <div className="board-thumbnail">
              📝
            </div>
            <div className="board-info">
              <div className="board-name">{board.name}</div>
              <div className="board-date">
                {new Date(board.updatedAt).toLocaleDateString()}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ========================================
// Assets Tab
// ========================================

function AssetsTab() {
  const { importAsset, deleteAsset, getAssets, loadAssetDataUrl } = useProjectStore();
  const [assets, setAssets] = useState<ImportedAsset[]>([]);
  const [thumbnails, setThumbnails] = useState<Map<string, string>>(new Map());
  const [isImporting, setIsImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // アセット一覧を取得
  useEffect(() => {
    setAssets(getAssets());
  }, [getAssets]);

  // サムネイルを読み込み
  useEffect(() => {
    const loadThumbnails = async () => {
      const newThumbnails = new Map<string, string>();
      for (const asset of assets) {
        if (asset.type === 'image') {
          const dataUrl = await loadAssetDataUrl(asset.uuid);
          if (dataUrl) {
            newThumbnails.set(asset.uuid, dataUrl);
          }
        }
      }
      setThumbnails(newThumbnails);
    };
    loadThumbnails();
  }, [assets, loadAssetDataUrl]);

  const handleImportClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setIsImporting(true);
    try {
      for (const file of Array.from(files)) {
        await importAsset(file);
      }
      setAssets(getAssets());
    } finally {
      setIsImporting(false);
      // ファイル入力をリセット
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }, [importAsset, getAssets]);

  const handleDelete = useCallback(async (uuid: string, fileName: string) => {
    if (confirm(`Delete "${fileName}"?`)) {
      await deleteAsset(uuid);
      setAssets(getAssets());
    }
  }, [deleteAsset, getAssets]);

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div>
      {/* ツールバー */}
      <div className="assets-toolbar">
        <button 
          className="dashboard-btn primary"
          onClick={handleImportClick}
          disabled={isImporting}
        >
          {isImporting ? '📤 Importing...' : '📤 Import'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,application/pdf"
          multiple
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />
        <span className="assets-count">
          {assets.length} asset{assets.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* アセット一覧 */}
      {assets.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">🖼️</div>
          <h3 className="empty-state-title">No assets yet</h3>
          <p className="empty-state-message">
            Import images or PDFs to use in your boards
          </p>
        </div>
      ) : (
        <div className="asset-grid">
          {assets.map((asset: ImportedAsset) => (
            <div key={asset.uuid} className="asset-card">
              <div className="asset-thumbnail">
                {asset.type === 'image' && thumbnails.has(asset.uuid) ? (
                  <img src={thumbnails.get(asset.uuid)} alt={asset.fileName} />
                ) : asset.type === 'document' ? (
                  <span className="asset-icon">📄</span>
                ) : (
                  <span className="asset-icon">🖼️</span>
                )}
              </div>
              <div className="asset-info">
                <div className="asset-name" title={asset.fileName}>
                  {asset.fileName}
                </div>
                <div className="asset-meta">
                  {formatFileSize(asset.size)}
                </div>
              </div>
              <button
                className="asset-delete-btn"
                onClick={() => handleDelete(asset.uuid, asset.fileName)}
                title="Delete"
              >
                🗑️
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ========================================
// Settings Tab (Placeholder)
// ========================================

function SettingsTab() {
  const { project } = useProjectStore();
  
  if (!project) return null;
  
  const { background } = project.config;

  return (
    <div style={{ maxWidth: 400 }}>
      <h3 style={{ marginBottom: 16 }}>Background Settings</h3>
      
      <div style={{ marginBottom: 16 }}>
        <label style={{ display: 'block', marginBottom: 4, fontSize: 14 }}>
          Color
        </label>
        <input 
          type="color" 
          value={background.color}
          disabled
          style={{ width: 60, height: 32 }}
        />
      </div>

      <div style={{ marginBottom: 16 }}>
        <label style={{ display: 'block', marginBottom: 4, fontSize: 14 }}>
          Pattern
        </label>
        <select 
          value={background.pattern}
          disabled
          style={{
            padding: '8px 12px',
            borderRadius: 6,
            border: '1px solid var(--border-light)',
            fontSize: 14,
            width: '100%',
          }}
        >
          <option value="none">None</option>
          <option value="dots">Dots</option>
          <option value="grid">Grid</option>
          <option value="lines">Lines</option>
        </select>
      </div>

      <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
        Settings editing coming soon...
      </p>
    </div>
  );
}
