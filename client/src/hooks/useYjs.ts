/**
 * useYjs - シンプルな P2P コラボレーションフック
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import * as Y from 'yjs';
import { WebrtcProvider } from 'y-webrtc';
import type { 
  WbelxEvent, 
  DrawEvent, 
  EraseEvent, 
  CursorInfo, 
  WbelxState,
  StrokeOperation,
  OverlayAddEvent,
  OverlayRemoveEvent,
  OverlayTransformEvent,
  OverlayViewportEvent,
  OverlayState,
  Operation,
} from '../types';
import { computeState, getActiveStrokes, getActiveOverlays } from '../utils/statemachine';
import { generateEraseId, getTimestamp, getOrCreateSessionId } from '../utils/common';
import { eventsToWbelx } from '../utils/wbelx-parser';

// シグナリングサーバー
const getSignalingServers = (): string[] => {
  if (import.meta.env.VITE_SIGNALING_URL) {
    return [import.meta.env.VITE_SIGNALING_URL];
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.hostname;
  return [`${protocol}//${host}:4444`];
};

// ランダムなユーザー情報
const getRandomColor = () => ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899'][Math.floor(Math.random() * 7)];
const getRandomName = () => {
  const adj = ['Swift', 'Bright', 'Calm', 'Bold', 'Keen'];
  const noun = ['Fox', 'Bear', 'Wolf', 'Owl', 'Deer'];
  return adj[Math.floor(Math.random() * 5)] + noun[Math.floor(Math.random() * 5)];
};

export interface UseYjsOptions {
  roomId: string;
  enabled?: boolean;
  isHost?: boolean;
  initialEvents?: WbelxEvent[];
  onPeerJoin?: (name: string) => void;
  onPeerLeave?: (name: string) => void;
}

export interface UseYjsReturn {
  isConnected: boolean;
  signalingConnected: boolean;
  peerCount: number;
  isHost: boolean;
  isHostConnected: boolean;
  guestsPresent: boolean;
  isJoiningRoom: boolean;
  peerSearchTimedOut: boolean;
  hasSyncedData: boolean;
  events: WbelxEvent[];
  state: WbelxState;
  activeStrokes: DrawEvent[];
  activeOverlays: OverlayState[];
  cursors: Map<string, CursorInfo>;
  addDrawEvent: (event: DrawEvent) => void;
  addEraseEvent: (event: EraseEvent, targetStrokes: DrawEvent[]) => void;
  addOverlayEvent: (event: OverlayAddEvent) => void;
  removeOverlayEvent: (event: OverlayRemoveEvent, targetOverlays: OverlayAddEvent[]) => void;
  transformOverlayEvent: (event: OverlayTransformEvent, before: { x: number; y: number; width: number; height: number; rotation: number }) => void;
  viewportOverlayEvent: (event: OverlayViewportEvent, before: { viewport: { x: number; y: number; width: number; height: number }; page: number }) => void;
  performUndo: () => void;
  performRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  updateCursor: (x: number, y: number) => void;
  hideCursor: () => void;
  sessionId: string;
  userId: string;
  userColor: string;
  exportWbelx: () => string;
  exportSnapshotWbelx: () => string;
  hasContent: boolean;
  // アセット転送
  incomingAssetRequests: string[];
  receivedAssets: Map<string, { data: string; mimeType: string }>;
  requestAsset: (uuid: string) => void;
  sendAssetResponse: (uuid: string, data: string, mimeType: string) => void;
  clearAssetRequest: (uuid: string) => void;
}

export function useYjs({ 
  roomId, 
  enabled = true, 
  isHost = false,
  initialEvents = [],
  onPeerJoin,
  onPeerLeave,
}: UseYjsOptions): UseYjsReturn {
  const [isConnected, setIsConnected] = useState(false);
  const [signalingConnected, setSignalingConnected] = useState(false);
  const [peerCount, setPeerCount] = useState(0);
  const [events, setEvents] = useState<WbelxEvent[]>([]);
  const [state, setState] = useState<WbelxState>(() => computeState([]));
  const [cursors, setCursors] = useState<Map<string, CursorInfo>>(new Map());
  const [isHostConnected, setIsHostConnected] = useState(isHost);
  const [guestsPresent, setGuestsPresent] = useState(false);
  const [isJoiningRoom, setIsJoiningRoom] = useState(true);
  const [peerSearchTimedOut, setPeerSearchTimedOut] = useState(false);
  const [hasSyncedData, setHasSyncedData] = useState(false);
  const [undoStack, setUndoStack] = useState<Operation[]>([]);
  const [redoStack, setRedoStack] = useState<Operation[]>([]);
  
  // アセットリクエスト/レスポンス（Awareness経由）
  const [pendingAssetRequests, setPendingAssetRequests] = useState<Set<string>>(new Set());
  const [receivedAssets, setReceivedAssets] = useState<Map<string, { data: string; mimeType: string }>>(new Map());
  const [incomingAssetRequests, setIncomingAssetRequests] = useState<string[]>([]);
  
  const ydocRef = useRef<Y.Doc | null>(null);
  const providerRef = useRef<WebrtcProvider | null>(null);
  const yEventsRef = useRef<Y.Array<WbelxEvent> | null>(null);
  const sessionIdRef = useRef(getOrCreateSessionId());
  const userIdRef = useRef(`user:${Math.random().toString(36).slice(2, 10)}`);
  const userColorRef = useRef(getRandomColor());
  const userNameRef = useRef(getRandomName());
  const initialLoadedRef = useRef(false);
  
  // ピア追跡用
  const knownPeersRef = useRef<Map<number, string>>(new Map());
  const onPeerJoinRef = useRef(onPeerJoin);
  const onPeerLeaveRef = useRef(onPeerLeave);
  
  // コールバック参照を最新に保つ
  useEffect(() => {
    onPeerJoinRef.current = onPeerJoin;
    onPeerLeaveRef.current = onPeerLeave;
  }, [onPeerJoin, onPeerLeave]);

  useEffect(() => {
    if (!enabled || !roomId) return;


    // リセット
    setIsJoiningRoom(true);
    setPeerSearchTimedOut(false);
    setHasSyncedData(false);
    setIsHostConnected(isHost);
    setGuestsPresent(false);
    initialLoadedRef.current = false;

    const ydoc = new Y.Doc();
    ydocRef.current = ydoc;
    const yEvents = ydoc.getArray<WbelxEvent>('events');
    yEventsRef.current = yEvents;

    const provider = new WebrtcProvider(roomId, ydoc, {
      signaling: getSignalingServers(),
      peerOpts: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun.cloudflare.com:3478' },
        ],
      },
    });
    providerRef.current = provider;

    // 初期イベントをロード
    const loadInitial = () => {
      if (initialLoadedRef.current || !isHost) return;
      const current = yEvents.toArray();
      if (current.length > 0) {
        initialLoadedRef.current = true;
        return;
      }
      if (initialEvents.length > 0) {
        ydoc.transact(() => {
          for (const e of initialEvents) {
            yEvents.push([e]);
          }
        });
        
        // 初期イベントから undoStack を構築（DrawEvent のみ）
        const initialUndoStack: StrokeOperation[] = [];
        for (const e of initialEvents) {
          if (e.type === 'D') {
            initialUndoStack.push({
              type: 'draw',
              strokeId: e.id,
              strokeData: e,
            });
          }
        }
        if (initialUndoStack.length > 0) {
          setUndoStack(initialUndoStack);
        }
      }
      initialLoadedRef.current = true;
    };

    // タイマー
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    
    const startTimeout = () => {
      if (isHost) {
        timeoutId = setTimeout(() => {
          loadInitial();
          setIsJoiningRoom(false);
        }, 500);
      } else {
        timeoutId = setTimeout(() => {
          if (yEvents.toArray().length === 0) {
            setPeerSearchTimedOut(true);
          }
          setIsJoiningRoom(false);
        }, 5000);
      }
    };

    const clearTimeoutIfSet = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    // シグナリング接続
    provider.on('status', ({ connected }: { connected: boolean }) => {
      setSignalingConnected(connected);
      if (connected) {
        setIsConnected(true);
        startTimeout();
      }
    });

    // 同期完了
    provider.on('synced', ({ synced }: { synced: boolean }) => {
      if (synced) {
        const current = yEvents.toArray();
        if (current.length > 0) {
          setHasSyncedData(true);
          clearTimeoutIfSet();
          setIsJoiningRoom(false);
        }
        if (isHost && !initialLoadedRef.current) {
          loadInitial();
        }
      }
    });

    // Awareness
    const awareness = provider.awareness;
    awareness.setLocalState({
      user: { id: userIdRef.current, name: userNameRef.current, color: userColorRef.current },
      isHost,
      cursor: null,
    });

    const updateAwareness = () => {
      const states = awareness.getStates();
      const newCursors = new Map<string, CursorInfo>();
      let count = 0;
      let foundHost = isHost;
      let foundGuests = false;
      
      // 現在のピアを追跡
      const currentPeers = new Map<number, string>();
      
      // 他ピアからのアセットリクエストとレスポンスを収集
      const incomingRequests: string[] = [];
      const incomingResponses: Array<{ uuid: string; data: string; mimeType: string }> = [];

      states.forEach((st, clientId) => {
        if (clientId === awareness.clientID) return;
        count++;
        if (st.isHost) foundHost = true;
        else foundGuests = true;
        
        const peerName = st.user?.name || 'Unknown';
        currentPeers.set(clientId, peerName);
        
        if (st.user && st.cursor) {
          newCursors.set(st.user.id, {
            id: st.user.id,
            name: st.user.name,
            x: st.cursor.x,
            y: st.cursor.y,
            color: st.user.color,
          });
        }
        
        // アセットリクエストを収集
        if (st.assetRequests && Array.isArray(st.assetRequests)) {
          for (const uuid of st.assetRequests) {
            if (!incomingRequests.includes(uuid)) {
              incomingRequests.push(uuid);
            }
          }
        }
        
        // アセットレスポンスを収集
        if (st.assetResponse && st.assetResponse.uuid && st.assetResponse.data) {
          incomingResponses.push(st.assetResponse);
        }
      });
      
      // 新しく参加したピアを検出
      currentPeers.forEach((name, clientId) => {
        if (!knownPeersRef.current.has(clientId)) {
          onPeerJoinRef.current?.(name);
        }
      });
      
      // 切断したピアを検出
      knownPeersRef.current.forEach((name, clientId) => {
        if (!currentPeers.has(clientId)) {
          onPeerLeaveRef.current?.(name);
        }
      });
      
      // 既知のピアを更新
      knownPeersRef.current = currentPeers;

      setCursors(newCursors);
      setPeerCount(count);
      setIsHostConnected(foundHost);
      if (foundGuests) {
        setGuestsPresent(true);
        clearTimeoutIfSet();
        setIsJoiningRoom(false);
      }
      
      // アセットリクエストを更新
      setIncomingAssetRequests(incomingRequests);
      
      // アセットレスポンスを処理
      if (incomingResponses.length > 0) {
        setReceivedAssets(prev => {
          const next = new Map(prev);
          for (const resp of incomingResponses) {
            if (!next.has(resp.uuid)) {
              next.set(resp.uuid, { data: resp.data, mimeType: resp.mimeType });
            }
          }
          return next;
        });
      }
    };

    awareness.on('change', updateAwareness);
    updateAwareness();

    // イベント監視
    const observeEvents = () => {
      const all = yEvents.toArray();
      setEvents(all);
      setState(computeState(all));
    };
    yEvents.observe(observeEvents);
    observeEvents();

    return () => {
      clearTimeoutIfSet();
      awareness.off('change', updateAwareness);
      yEvents.unobserve(observeEvents);
      provider.destroy();
      ydoc.destroy();
    };
  }, [roomId, enabled, isHost, initialEvents]);

  // イベント追加
  const addDrawEvent = useCallback((event: DrawEvent) => {
    if (!yEventsRef.current) return;
    const e = { ...event, sessionId: event.sessionId || sessionIdRef.current };
    yEventsRef.current.push([e]);
    setUndoStack(prev => [...prev, { type: 'draw', strokeId: e.id, strokeData: e }]);
    setRedoStack([]);
  }, []);

  const addEraseEvent = useCallback((event: EraseEvent, targetStrokes: DrawEvent[]) => {
    if (!yEventsRef.current) return;
    const e = { ...event, sessionId: event.sessionId || sessionIdRef.current };
    yEventsRef.current.push([e]);
    setUndoStack(prev => [...prev, { type: 'erase', eraseId: e.id, targetIds: e.targetIds, targetStrokes }]);
    setRedoStack([]);
  }, []);

  // オーバーレイ追加
  const addOverlayEvent = useCallback((event: OverlayAddEvent) => {
    if (!yEventsRef.current) return;
    const e = { ...event, sessionId: event.sessionId || sessionIdRef.current };
    yEventsRef.current.push([e]);
    setUndoStack(prev => [...prev, { type: 'overlayAdd', overlayId: e.overlayId, overlayData: e }]);
    setRedoStack([]);
  }, []);

  // アセットをリクエスト（ゲスト用）
  const requestAsset = useCallback((uuid: string) => {
    const a = providerRef.current?.awareness;
    if (!a) return;
    
    // 既にリクエスト中ならスキップ
    if (pendingAssetRequests.has(uuid)) return;
    
    setPendingAssetRequests(prev => new Set(prev).add(uuid));
    
    const currentState = a.getLocalState() || {};
    const currentRequests = currentState.assetRequests || [];
    if (!currentRequests.includes(uuid)) {
      a.setLocalState({
        ...currentState,
        assetRequests: [...currentRequests, uuid],
      });
    }
  }, [pendingAssetRequests]);

  // アセットレスポンスを送信（ホスト/保持者用）
  const sendAssetResponse = useCallback((uuid: string, data: string, mimeType: string) => {
    const a = providerRef.current?.awareness;
    if (!a) return;
    
    const currentState = a.getLocalState() || {};
    a.setLocalState({
      ...currentState,
      assetResponse: { uuid, data, mimeType },
    });
    
    // 少し待ってからレスポンスをクリア（他のピアが受け取る時間を確保）
    setTimeout(() => {
      const state = a.getLocalState() || {};
      if (state.assetResponse?.uuid === uuid) {
        a.setLocalState({
          ...state,
          assetResponse: null,
        });
      }
    }, 2000);
  }, []);

  // リクエストをクリア（受信後）
  const clearAssetRequest = useCallback((uuid: string) => {
    const a = providerRef.current?.awareness;
    if (!a) return;
    
    setPendingAssetRequests(prev => {
      const next = new Set(prev);
      next.delete(uuid);
      return next;
    });
    
    const currentState = a.getLocalState() || {};
    const currentRequests = (currentState.assetRequests || []) as string[];
    a.setLocalState({
      ...currentState,
      assetRequests: currentRequests.filter((id: string) => id !== uuid),
    });
  }, []);

  // オーバーレイ削除
  const removeOverlayEvent = useCallback((event: OverlayRemoveEvent, targetOverlays: OverlayAddEvent[]) => {
    if (!yEventsRef.current) return;
    const e = { ...event, sessionId: event.sessionId || sessionIdRef.current };
    yEventsRef.current.push([e]);
    setUndoStack(prev => [...prev, { 
      type: 'overlayRemove', 
      removeId: e.removeId, 
      targetOverlayIds: e.targetOverlayIds,
      targetOverlays 
    }]);
    setRedoStack([]);
  }, []);

  // オーバーレイ移動/リサイズ
  const transformOverlayEvent = useCallback((
    event: OverlayTransformEvent,
    before: { x: number; y: number; width: number; height: number; rotation: number }
  ) => {
    if (!yEventsRef.current) return;
    const e = { ...event, sessionId: event.sessionId || sessionIdRef.current };
    yEventsRef.current.push([e]);
    setUndoStack(prev => [...prev, { 
      type: 'overlayTransform', 
      overlayId: e.overlayId,
      before,
      after: { x: e.x, y: e.y, width: e.width, height: e.height, rotation: e.rotation }
    }]);
    setRedoStack([]);
  }, []);

  // オーバーレイ viewport 変更
  const viewportOverlayEvent = useCallback((
    event: OverlayViewportEvent,
    before: { viewport: { x: number; y: number; width: number; height: number }; page: number }
  ) => {
    if (!yEventsRef.current) return;
    const e = { ...event, sessionId: event.sessionId || sessionIdRef.current };
    yEventsRef.current.push([e]);
    setUndoStack(prev => [...prev, { 
      type: 'overlayViewport', 
      overlayId: e.overlayId,
      before,
      after: { viewport: e.viewport, page: e.page }
    }]);
    setRedoStack([]);
  }, []);

  // Undo/Redo
  const performUndo = useCallback(() => {
    if (undoStack.length === 0 || !yEventsRef.current) return;
    const op = undoStack[undoStack.length - 1];
    
    if (op.type === 'draw') {
      if (!state.activeStrokeIds.has(op.strokeId)) return;
      yEventsRef.current.push([{
        type: 'E',
        timestamp: getTimestamp(),
        sessionId: sessionIdRef.current,
        id: generateEraseId(),
        targetIds: [op.strokeId],
      }]);
    } else if (op.type === 'erase') {
      for (const stroke of op.targetStrokes) {
        yEventsRef.current.push([{ ...stroke, timestamp: getTimestamp(), sessionId: sessionIdRef.current }]);
      }
    } else if (op.type === 'overlayAdd') {
      if (!state.activeOverlayIds.has(op.overlayId)) return;
      yEventsRef.current.push([{
        type: 'OR',
        timestamp: getTimestamp(),
        sessionId: sessionIdRef.current,
        removeId: `r:${Date.now().toString(36)}`,
        targetOverlayIds: [op.overlayId],
      }]);
    } else if (op.type === 'overlayRemove') {
      for (const overlay of op.targetOverlays) {
        yEventsRef.current.push([{ ...overlay, timestamp: getTimestamp(), sessionId: sessionIdRef.current }]);
      }
    } else if (op.type === 'overlayTransform') {
      // 変形前の状態に戻す
      yEventsRef.current.push([{
        type: 'OT',
        timestamp: getTimestamp(),
        sessionId: sessionIdRef.current,
        overlayId: op.overlayId,
        x: op.before.x,
        y: op.before.y,
        width: op.before.width,
        height: op.before.height,
        rotation: op.before.rotation,
      }]);
    } else if (op.type === 'overlayViewport') {
      // viewport を前の状態に戻す
      yEventsRef.current.push([{
        type: 'OV',
        timestamp: getTimestamp(),
        sessionId: sessionIdRef.current,
        overlayId: op.overlayId,
        viewport: op.before.viewport,
        page: op.before.page,
      }]);
    }
    
    setUndoStack(prev => prev.slice(0, -1));
    setRedoStack(prev => [...prev, op]);
  }, [undoStack, state.activeStrokeIds, state.activeOverlayIds]);

  const performRedo = useCallback(() => {
    if (redoStack.length === 0 || !yEventsRef.current) return;
    const op = redoStack[redoStack.length - 1];
    
    if (op.type === 'draw') {
      yEventsRef.current.push([{ ...op.strokeData, timestamp: getTimestamp(), sessionId: sessionIdRef.current }]);
    } else if (op.type === 'erase') {
      yEventsRef.current.push([{
        type: 'E',
        timestamp: getTimestamp(),
        sessionId: sessionIdRef.current,
        id: generateEraseId(),
        targetIds: op.targetIds,
      }]);
    } else if (op.type === 'overlayAdd') {
      yEventsRef.current.push([{ ...op.overlayData, timestamp: getTimestamp(), sessionId: sessionIdRef.current }]);
    } else if (op.type === 'overlayRemove') {
      yEventsRef.current.push([{
        type: 'OR',
        timestamp: getTimestamp(),
        sessionId: sessionIdRef.current,
        removeId: `r:${Date.now().toString(36)}`,
        targetOverlayIds: op.targetOverlayIds,
      }]);
    } else if (op.type === 'overlayTransform') {
      // 変形後の状態を再適用
      yEventsRef.current.push([{
        type: 'OT',
        timestamp: getTimestamp(),
        sessionId: sessionIdRef.current,
        overlayId: op.overlayId,
        x: op.after.x,
        y: op.after.y,
        width: op.after.width,
        height: op.after.height,
        rotation: op.after.rotation,
      }]);
    } else if (op.type === 'overlayViewport') {
      // viewport を後の状態に戻す
      yEventsRef.current.push([{
        type: 'OV',
        timestamp: getTimestamp(),
        sessionId: sessionIdRef.current,
        overlayId: op.overlayId,
        viewport: op.after.viewport,
        page: op.after.page,
      }]);
    }
    
    setRedoStack(prev => prev.slice(0, -1));
    setUndoStack(prev => [...prev, op]);
  }, [redoStack]);

  // カーソル
  const updateCursor = useCallback((x: number, y: number) => {
    const a = providerRef.current?.awareness;
    if (a) a.setLocalState({ ...a.getLocalState(), cursor: { x, y } });
  }, []);

  const hideCursor = useCallback(() => {
    const a = providerRef.current?.awareness;
    if (a) a.setLocalState({ ...a.getLocalState(), cursor: null });
  }, []);

  // エクスポート
  const exportWbelx = useCallback(() => eventsToWbelx(events), [events]);
  const exportSnapshotWbelx = useCallback(() => {
    const snaps: WbelxEvent[] = [];
    
    // ストローク
    for (const id of state.activeStrokeIds) {
      const s = state.strokes.get(id);
      if (s) snaps.push(s);
    }
    
    // オーバーレイ
    for (const id of state.activeOverlayIds) {
      const overlay = state.overlays.get(id);
      if (overlay) {
        snaps.push({
          type: 'OA',
          timestamp: getTimestamp(),
          sessionId: sessionIdRef.current,
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
      }
    }
    
    const h = `#SNAPSHOT,${Date.now().toString(36)}`;
    const b = eventsToWbelx(snaps);
    return b ? `${h}\n${b}` : h;
  }, [state]);

  return {
    isConnected,
    signalingConnected,
    peerCount,
    isHost,
    isHostConnected,
    guestsPresent,
    isJoiningRoom,
    peerSearchTimedOut,
    hasSyncedData,
    events,
    state,
    activeStrokes: getActiveStrokes(state),
    activeOverlays: getActiveOverlays(state),
    cursors,
    addDrawEvent,
    addEraseEvent,
    addOverlayEvent,
    removeOverlayEvent,
    transformOverlayEvent,
    viewportOverlayEvent,
    performUndo,
    performRedo,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    updateCursor,
    hideCursor,
    sessionId: sessionIdRef.current,
    userId: userIdRef.current,
    userColor: userColorRef.current,
    exportWbelx,
    exportSnapshotWbelx,
    hasContent: events.length > 0,
    // アセット転送
    incomingAssetRequests,
    receivedAssets,
    requestAsset,
    sendAssetResponse,
    clearAssetRequest,
  };
}
