import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useProjectStore } from '../hooks/useProjectStore';
import { useYjs } from '../hooks/useYjs';
import { WhiteboardCanvas } from '../components/WhiteboardCanvas';
import { Toolbar } from '../components/Toolbar';
import type { 
  ToolType, 
  StrokeWidthKey, 
  WbelxEvent, 
  SnapshotMarkerEvent,
  OverlayAddEvent,
  OverlayRemoveEvent,
} from '../types';
import { STROKE_WIDTHS, COLOR_PALETTE, canAddAsOverlay } from '../types';
import { getTimestamp, generateSnapshotId } from '../utils/common';
import {
  saveBoardEvents,
  loadBoardEvents,
  saveBoardSnapshot,
  loadBoardSnapshot,
  deleteBoardSnapshot,
  loadAssetFileAsDataUrl,
} from '../utils/storage';
import { loadPdfDocument, renderPdfPage } from '../utils/pdf';

// 通知の型
interface Notification {
  id: number;
  type: 'join' | 'leave';
  name: string;
}

let notificationIdCounter = 0;

export function BoardEditor() {
  const { boardId } = useParams<{ boardId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { project, getBoardUuid, getAssets, getBoards, onAssetAddedToBoard, onAssetRemovedFromBoard } = useProjectStore();

  // ツール状態
  const [tool, setTool] = useState<ToolType>('pen');
  const [color, setColor] = useState<string>(COLOR_PALETTE[0]);
  const [strokeWidthKey, setStrokeWidthKey] = useState<StrokeWidthKey>('medium');
  
  // 初期イベント
  const [initialEvents, setInitialEvents] = useState<WbelxEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  
  // 通知
  const [notifications, setNotifications] = useState<Notification[]>([]);
  
  // オーバーレイ関連
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  const [overlayImages, setOverlayImages] = useState<Map<string, HTMLImageElement>>(new Map());

  // ボード情報
  const boardInfo = boardId ? project?.config.boards.get(boardId) : undefined;
  const localBoardUuid = boardId ? getBoardUuid(boardId) : undefined;
  
  // 共有リンク判定
  const roomIdFromQuery = searchParams.get('room');
  const isJoiningViaShareLink = !!roomIdFromQuery;
  const isHost = !!project && !isJoiningViaShareLink;
  
  const roomId = useMemo(() => {
    return roomIdFromQuery || localBoardUuid || '';
  }, [roomIdFromQuery, localBoardUuid]);

  // 最後に保存したイベント数（重複保存防止）
  const lastSavedEventCountRef = useRef(0);
  
  // 通知を追加
  const addNotification = useCallback((type: 'join' | 'leave', name: string) => {
    const id = ++notificationIdCounter;
    setNotifications(prev => [...prev, { id, type, name }]);
    // 3秒後に自動削除
    setTimeout(() => {
      setNotifications(prev => prev.filter(n => n.id !== id));
    }, 3000);
  }, []);
  
  // ピア接続/切断コールバック
  const handlePeerJoin = useCallback((name: string) => {
    addNotification('join', name);
  }, [addNotification]);
  
  const handlePeerLeave = useCallback((name: string) => {
    addNotification('leave', name);
  }, [addNotification]);

  // ========================================
  // 1. ボードを開いたとき：IndexedDB から読み込む
  // ========================================
  useEffect(() => {
    if (!isHost || !boardId) {
      setIsLoading(false);
      return;
    }

    const load = async () => {
      try {
        
        // スナップショットを確認
        const snapshot = await loadBoardSnapshot(boardId);
        if (snapshot && snapshot.length > 0) {
          setInitialEvents(snapshot);
          setIsLoading(false);
          return;
        }
        
        // なければイベントログを読み込む
        const events = await loadBoardEvents(boardId);
        // S イベントを除去
        const filtered = events.filter(e => e.type !== 'S');
        setInitialEvents(filtered);
        setIsLoading(false);
      } catch (error) {
        console.error('[BoardEditor] Load error:', error);
        setLoadError(error instanceof Error ? error.message : 'Failed to load');
        setIsLoading(false);
      }
    };

    load();
  }, [isHost, boardId]);

  // P2P コラボレーション
  const {
    isConnected,
    peerCount,
    activeStrokes,
    activeOverlays,
    cursors,
    sessionId,
    addDrawEvent,
    addEraseEvent,
    addOverlayEvent,
    removeOverlayEvent,
    transformOverlayEvent,
    performUndo,
    performRedo,
    canUndo,
    canRedo,
    updateCursor,
    hideCursor,
    exportWbelx,
    exportSnapshotWbelx,
    hasContent,
    isJoiningRoom,
    peerSearchTimedOut,
    hasSyncedData,
    isHostConnected,
    guestsPresent,
    events,
    // アセット転送
    incomingAssetRequests,
    receivedAssets,
    requestAsset,
    sendAssetResponse,
    clearAssetRequest,
  } = useYjs({
    roomId,
    enabled: !!roomId && !isLoading,
    isHost,
    initialEvents,
    onPeerJoin: handlePeerJoin,
    onPeerLeave: handlePeerLeave,
  });

  // ========================================
  // オーバーレイ画像の読み込み
  // ========================================
  useEffect(() => {
    const loadImages = async () => {
      const newImages = new Map<string, HTMLImageElement>();
      const missingUuids: string[] = [];
      
      for (const overlay of activeOverlays) {
        // 既にロード済みならスキップ
        if (overlayImages.has(overlay.assetUuid)) {
          newImages.set(overlay.assetUuid, overlayImages.get(overlay.assetUuid)!);
          continue;
        }
        
        // アセットタイプを取得
        const asset = project?.assetIndex.byUuid.get(overlay.assetUuid);
        const assetType = asset?.type || 'image';
        
        // 画像・PDF を読み込む（IndexedDB から）
        try {
          const dataUrl = await loadAssetFileAsDataUrl(overlay.assetUuid);
          if (dataUrl) {
            if (assetType === 'document') {
              // PDF の場合は指定ページを描画
              const pdfDoc = await loadPdfDocument(dataUrl);
              const pageNum = overlay.page > 0 ? overlay.page : 1;
              const img = await renderPdfPage(pdfDoc, pageNum);
              newImages.set(overlay.assetUuid, img);
            } else if (assetType === 'image') {
              // 画像の場合
              const img = new Image();
              img.src = dataUrl;
              await new Promise<void>((resolve, reject) => {
                img.onload = () => resolve();
                img.onerror = reject;
              });
              newImages.set(overlay.assetUuid, img);
            }
            // board タイプは後で実装（サムネイル描画）
            continue;
          }
        } catch (error) {
          console.warn('Failed to load asset:', overlay.assetUuid, error);
        }
        
        // receivedAssets から取得を試みる
        const received = receivedAssets.get(overlay.assetUuid);
        if (received) {
          try {
            const fullDataUrl = `data:${received.mimeType};base64,${received.data}`;
            
            if (received.mimeType === 'application/pdf') {
              // PDF の場合
              const pdfDoc = await loadPdfDocument(fullDataUrl);
              const pageNum = overlay.page > 0 ? overlay.page : 1;
              const img = await renderPdfPage(pdfDoc, pageNum);
              newImages.set(overlay.assetUuid, img);
            } else {
              // 画像の場合
              const img = new Image();
              img.src = fullDataUrl;
              await new Promise<void>((resolve, reject) => {
                img.onload = () => resolve();
                img.onerror = reject;
              });
              newImages.set(overlay.assetUuid, img);
            }
            clearAssetRequest(overlay.assetUuid);
            continue;
          } catch (error) {
            console.warn('Failed to load received asset:', overlay.assetUuid, error);
          }
        }
        
        // まだない場合はリクエスト
        missingUuids.push(overlay.assetUuid);
      }
      
      // 不足しているアセットをリクエスト
      for (const uuid of missingUuids) {
        requestAsset(uuid);
      }
      
      if (newImages.size > 0 || overlayImages.size !== newImages.size) {
        setOverlayImages(newImages);
      }
    };
    
    loadImages();
  }, [activeOverlays, receivedAssets, requestAsset, clearAssetRequest, project]);

  // ========================================
  // アセットリクエストへの応答（ホスト側）
  // ========================================
  useEffect(() => {
    if (incomingAssetRequests.length === 0) return;
    
    const respondToRequests = async () => {
      for (const uuid of incomingAssetRequests) {
        // 自分が持っているか確認
        const dataUrl = await loadAssetFileAsDataUrl(uuid);
        if (dataUrl) {
          // data:image/png;base64,xxxx の形式からBase64部分を抽出
          const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            const mimeType = match[1];
            const base64Data = match[2];
            sendAssetResponse(uuid, base64Data, mimeType);
          }
        }
      }
    };
    
    respondToRequests();
  }, [incomingAssetRequests, sendAssetResponse]);

  // アセット追加ハンドラ
  const handleAddAsset = useCallback((assetUuid: string) => {
    const event: OverlayAddEvent = {
      type: 'OA',
      timestamp: getTimestamp(),
      sessionId,
      overlayId: `o:${Date.now().toString(36)}`,
      assetUuid,
      x: 100,
      y: 100,
      width: 300,
      height: 200,
      rotation: 0,
      viewport: { x: 0, y: 0, width: 0, height: 0 },
      page: 0,
      zIndex: activeOverlays.length + 1,
      opacity: 1.0,
    };
    addOverlayEvent(event);
    
    // アセット参照を更新（ボードネスト用）
    if (localBoardUuid) {
      onAssetAddedToBoard(localBoardUuid, assetUuid);
    }
  }, [sessionId, activeOverlays.length, addOverlayEvent, localBoardUuid, onAssetAddedToBoard]);

  // オーバーレイ削除ハンドラ
  const handleRemoveOverlay = useCallback((event: OverlayRemoveEvent) => {
    // 削除対象のオーバーレイデータを取得
    const targetOverlays: OverlayAddEvent[] = [];
    const removedAssetUuids: string[] = [];
    
    for (const overlayId of event.targetOverlayIds) {
      const overlay = activeOverlays.find(o => o.overlayId === overlayId);
      if (overlay) {
        targetOverlays.push({
          type: 'OA',
          timestamp: '',
          sessionId: '',
          overlayId: overlay.overlayId,
          assetUuid: overlay.assetUuid,
          x: overlay.x,
          y: overlay.y,
          width: overlay.width,
          height: overlay.height,
          rotation: overlay.rotation,
          viewport: overlay.viewport,
          page: overlay.page,
          zIndex: overlay.zIndex,
          opacity: overlay.opacity,
        });
        removedAssetUuids.push(overlay.assetUuid);
      }
    }
    removeOverlayEvent(event, targetOverlays);
    
    // アセット参照を更新（ボードネスト用）
    if (localBoardUuid) {
      for (const assetUuid of removedAssetUuids) {
        // 同じアセットの他のオーバーレイが残っていないか確認
        const otherOverlays = activeOverlays.filter(
          o => o.assetUuid === assetUuid && !event.targetOverlayIds.includes(o.overlayId)
        );
        if (otherOverlays.length === 0) {
          onAssetRemovedFromBoard(localBoardUuid, assetUuid);
        }
      }
    }
  }, [activeOverlays, removeOverlayEvent, localBoardUuid, onAssetRemovedFromBoard]);

  // 利用可能なアセット（画像・PDF + 他のボード）
  const availableAssets = useMemo(() => {
    const assets: Array<{ uuid: string; fileName: string; type: 'image' | 'document' | 'board' }> = [];
    
    // 画像とPDF
    for (const a of getAssets()) {
      assets.push({
        uuid: a.uuid,
        fileName: a.fileName,
        type: a.type,
      });
    }
    
    // 他のボード（循環参照チェック付き）
    if (project && localBoardUuid) {
      const boards = getBoards();
      for (const board of boards) {
        // 自分自身はスキップ
        if (board.id === boardId) continue;
        
        // このボードの UUID を取得
        const boardAssetUuid = getBoardUuid(board.id);
        if (!boardAssetUuid) continue;
        
        // 循環参照チェック
        const boardAsset = project.assetIndex.byUuid.get(boardAssetUuid);
        if (boardAsset && canAddAsOverlay(localBoardUuid, boardAsset, project.assetIndex)) {
          assets.push({
            uuid: boardAssetUuid,
            fileName: board.name,
            type: 'board',
          });
        }
      }
    }
    
    return assets;
  }, [getAssets, getBoards, getBoardUuid, project, boardId, localBoardUuid]);

  // ========================================
  // 2. イベント変更時：IndexedDB に即時保存
  // ========================================
  useEffect(() => {
    if (!isHost || !boardId) return;
    if (events.length === 0) return;
    if (events.length === lastSavedEventCountRef.current) return;

    const save = async () => {
      await saveBoardEvents(boardId, events);
      lastSavedEventCountRef.current = events.length;
    };

    save();
  }, [isHost, boardId, events]);

  // ========================================
  // 3. 戻るボタン：S イベント + スナップショット保存
  // ========================================
  const handleBack = useCallback(async () => {
    if (isHost && boardId && events.length > 0) {
      
      // S イベントを追加
      const snapshotMarker: SnapshotMarkerEvent = {
        type: 'S',
        timestamp: getTimestamp(),
        sessionId,
        snapshotHash: generateSnapshotId(),
      };
      const eventsWithS = [...events, snapshotMarker];
      
      // イベントログを保存
      await saveBoardEvents(boardId, eventsWithS);
      
      // スナップショットを保存（ストローク + オーバーレイ）
      const snapshotEvents: WbelxEvent[] = [
        ...activeStrokes,
        ...activeOverlays.map(overlay => ({
          type: 'OA' as const,
          timestamp: getTimestamp(),
          sessionId,
          overlayId: overlay.overlayId,
          assetUuid: overlay.assetUuid,
          x: overlay.x,
          y: overlay.y,
          width: overlay.width,
          height: overlay.height,
          rotation: overlay.rotation,
          viewport: overlay.viewport,
          page: overlay.page,
          zIndex: overlay.zIndex,
          opacity: overlay.opacity,
        })),
      ];
      await saveBoardSnapshot(boardId, snapshotEvents);
      
    }
    
    navigate(isJoiningViaShareLink ? '/' : '/project');
  }, [isHost, boardId, events, sessionId, activeStrokes, activeOverlays, navigate, isJoiningViaShareLink]);

  // ゲストがいる場合はスナップショットをクリア
  useEffect(() => {
    if (isHost && boardId && guestsPresent) {
      deleteBoardSnapshot(boardId);
    }
  }, [isHost, boardId, guestsPresent]);

  // 共有リンクをコピー
  const handleCopyShareLink = useCallback(() => {
    const baseUrl = `${window.location.origin}${window.location.pathname}`;
    const shareUrl = `${baseUrl}?room=${encodeURIComponent(roomId)}`;
    navigator.clipboard.writeText(shareUrl).catch(() => {
      prompt('Share this link:', shareUrl);
    });
  }, [roomId]);

  // エクスポート
  const handleExportWbelx = useCallback(() => {
    const content = exportWbelx();
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${boardInfo?.name || 'board'}.wbelx`;
    a.click();
    URL.revokeObjectURL(url);
  }, [exportWbelx, boardInfo]);

  const handleExportSnapshot = useCallback(() => {
    const content = exportSnapshotWbelx();
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${boardInfo?.name || 'board'}.snap.wbelx`;
    a.click();
    URL.revokeObjectURL(url);
  }, [exportSnapshotWbelx, boardInfo]);

  // キーボードショートカット
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        e.shiftKey ? performRedo() : performUndo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        e.preventDefault();
        performRedo();
        return;
      }

      switch (e.key.toLowerCase()) {
        case 'v': setTool('select'); break;
        case 'p': setTool('pen'); break;
        case 'e': setTool('eraser'); break;
        case ' ': e.preventDefault(); setTool('pan'); break;
        case '1': setStrokeWidthKey('thin'); break;
        case '2': setStrokeWidthKey('medium'); break;
        case '3': setStrokeWidthKey('thick'); break;
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') setTool('pen');
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [performUndo, performRedo]);

  // ========================================
  // レンダリング
  // ========================================

  // ローディング
  if (isLoading) {
    return (
      <div className="loading-page">
        <div className="loading-spinner" />
        <p className="loading-message">ボードを読み込み中...</p>
      </div>
    );
  }

  // エラー
  if (loadError) {
    return (
      <div className="error-page">
        <div className="error-icon">⚠️</div>
        <h1 className="error-title">読み込みエラー</h1>
        <p className="error-message">{loadError}</p>
        <button className="error-btn primary" onClick={() => navigate('/')}>ホームに戻る</button>
      </div>
    );
  }

  // 共有リンクでタイムアウト
  if (isJoiningViaShareLink && peerSearchTimedOut && !hasSyncedData) {
    return (
      <div className="error-page">
        <div className="error-icon">🔍</div>
        <h1 className="error-title">ホワイトボードが見つかりません</h1>
        <p className="error-message">共有リンクが無効か、ホストが退出している可能性があります。</p>
        <button className="error-btn primary" onClick={() => navigate('/')}>ホームに戻る</button>
      </div>
    );
  }

  // 共有リンクで接続中
  if (isJoiningViaShareLink && isJoiningRoom) {
    return (
      <div className="loading-page">
        <div className="loading-spinner" />
        <p className="loading-message">接続中...</p>
      </div>
    );
  }

  // プロジェクトなし
  if (!project && !isJoiningViaShareLink) {
    navigate('/');
    return null;
  }

  // ボードなし
  if (!isJoiningViaShareLink && (!boardId || !boardInfo)) {
    navigate('/project');
    return null;
  }

  if (!roomId) {
    navigate('/');
    return null;
  }

  // ホストが準備中（P2P接続確立 + ゲスト検出/データロード中）
  const isHostPreparing = isHost && isJoiningRoom;

  return (
    <div className="editor">
      {/* 通知 */}
      {notifications.length > 0 && (
        <div className="notifications">
          {notifications.map(n => (
            <div key={n.id} className={`notification ${n.type}`}>
              {n.type === 'join' ? '👋' : '👤'} {n.name} が
              {n.type === 'join' ? '参加しました' : '退出しました'}
            </div>
          ))}
        </div>
      )}
      
      {/* ホスト準備中オーバーレイ */}
      {isHostPreparing && (
        <div className="preparing-overlay">
          <div className="preparing-content">
            <div className="loading-spinner" />
            <p className="preparing-message">セッションを準備中...</p>
            <p className="preparing-detail">
              {peerCount > 0 
                ? `${peerCount}人のゲストと同期中` 
                : 'ピアを検索中'}
            </p>
          </div>
        </div>
      )}
      
      {!isHost && !isHostConnected && (
        <div className="host-disconnected-banner">
          <span className="banner-icon">⚠️</span>
          <span className="banner-text">
            ホストとの接続が切れています。編集内容は保存されない可能性があります。
          </span>
        </div>
      )}
      
      <Toolbar
        boardName={boardInfo?.name || 'Shared Board'}
        tool={tool}
        color={color}
        strokeWidthKey={strokeWidthKey}
        canUndo={canUndo}
        canRedo={canRedo}
        isConnected={isConnected}
        peerCount={peerCount}
        hasContent={hasContent}
        hasAssets={availableAssets.length > 0}
        onBack={handleBack}
        onToolChange={setTool}
        onColorChange={setColor}
        onStrokeWidthChange={setStrokeWidthKey}
        onUndo={performUndo}
        onRedo={performRedo}
        onCopyShareLink={handleCopyShareLink}
        onExportWbelx={handleExportWbelx}
        onExportSnapshot={handleExportSnapshot}
        onAddAsset={handleAddAsset}
        availableAssets={availableAssets}
      />
      <main className={`canvas-container ${isHostPreparing ? 'preparing' : ''}`}>
        <WhiteboardCanvas
          activeStrokes={activeStrokes}
          activeOverlays={activeOverlays}
          cursors={cursors}
          tool={tool}
          color={color}
          strokeWidth={STROKE_WIDTHS[strokeWidthKey]}
          sessionId={sessionId}
          selectedOverlayId={selectedOverlayId}
          overlayImages={overlayImages}
          onAddDrawEvent={addDrawEvent}
          onAddEraseEvent={addEraseEvent}
          onRemoveOverlayEvent={handleRemoveOverlay}
          onTransformOverlay={transformOverlayEvent}
          onSelectOverlay={setSelectedOverlayId}
          onUpdateCursor={updateCursor}
          onHideCursor={hideCursor}
        />
      </main>
    </div>
  );
}
