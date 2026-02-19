/**
 * useYjs - シンプルな P2P コラボレーションフック
 */

import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
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
  OverlayStyleEvent,
  OverlayState,
  Operation,
  LassoMoveOperation,
} from '../types';
import { computeState, getActiveStrokes, getActiveOverlays } from '../utils/statemachine';
import { generateEraseId, getTimestamp, getOrCreateSessionId, generateSnapshotHash } from '../utils/common';
import { eventsToWbelx, createSnapshot } from '../utils/wbelx-parser';

// シグナリングサーバー
const getSignalingServers = (): string[] => {
  if (import.meta.env.VITE_SIGNALING_URL) {
    return [import.meta.env.VITE_SIGNALING_URL];
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.hostname;
  return [`${protocol}//${host}:4444`];
};

// ICE サーバー（STUN + 環境変数で TURN を追加可能）
const getIceServers = (): RTCIceServer[] => {
  const servers: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];
  const turnUrl = import.meta.env.VITE_TURN_URL;
  if (turnUrl) {
    servers.push({
      urls: turnUrl,
      username: import.meta.env.VITE_TURN_USERNAME || '',
      credential: import.meta.env.VITE_TURN_CREDENTIAL || '',
    });
  }
  return servers;
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
  transformOverlayEvent: (event: OverlayTransformEvent, before: Partial<{ x: number; y: number; width: number; height: number; rotation: number }>) => void;
  viewportOverlayEvent: (event: OverlayViewportEvent, before: Partial<{ viewport: { x: number; y: number; width: number; height: number }; page: number }>) => void;
  styleOverlayEvent: (event: OverlayStyleEvent, befores: Array<{ overlayId: string; before: Partial<{ zIndex: number; opacity: number }> }>) => void;
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
  // 投げ縄
  lassoMoveStrokes: (originalStrokes: DrawEvent[], movedStrokes: DrawEvent[]) => void;
  lassoDeleteStrokes: (strokes: DrawEvent[]) => void;
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

  const initialEventsRef = useRef(initialEvents);
  useEffect(() => { initialEventsRef.current = initialEvents; }, [initialEvents]);

  // Y.Doc は常時初期化（roomId なし＝スタンドアロンでもローカル編集可能にする）
  useEffect(() => {
    const ydoc = new Y.Doc();
    ydocRef.current = ydoc;
    const yEvents = ydoc.getArray<WbelxEvent>('events');
    yEventsRef.current = yEvents;

    // イベント監視（ローカル編集にも対応）
    const observeLocal = () => {
      const all = yEvents.toArray();
      setEvents(all);
      setState(computeState(all));
    };
    yEvents.observe(observeLocal);

    // initialEvents をロード（スタンドアロン時）
    if (isHost && initialEventsRef.current.length > 0) {
      ydoc.transact(() => {
        for (const e of initialEventsRef.current) {
          yEvents.push([e]);
        }
      });
      const initialUndoStack: StrokeOperation[] = [];
      for (const e of initialEventsRef.current) {
        if (e.type === 'D') {
          initialUndoStack.push({ type: 'draw', strokeId: e.id, strokeData: e });
        }
      }
      if (initialUndoStack.length > 0) setUndoStack(initialUndoStack);
    }

    return () => {
      yEvents.unobserve(observeLocal);
      ydoc.destroy();
      ydocRef.current = null;
      yEventsRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // マウント時1回のみ（initialEventsはref経由で参照）

  // WebrtcProvider: roomId がある場合のみ接続
  useEffect(() => {
    if (!enabled || !roomId) return;
    const ydoc = ydocRef.current;
    const yEvents = yEventsRef.current;
    if (!ydoc || !yEvents) return;

    // リセット
    setIsJoiningRoom(true);
    setPeerSearchTimedOut(false);
    setHasSyncedData(false);
    setIsHostConnected(isHost);
    setGuestsPresent(false);
    initialLoadedRef.current = false;

    const provider = new WebrtcProvider(roomId, ydoc, {
      signaling: getSignalingServers(),
      peerOpts: {
        iceServers: getIceServers(),
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
      if (initialEventsRef.current.length > 0) {
        ydoc.transact(() => {
          for (const e of initialEventsRef.current) {
            yEvents.push([e]);
          }
        });

        // 初期イベントから undoStack を構築（DrawEvent のみ）
        const initialUndoStack: StrokeOperation[] = [];
        for (const e of initialEventsRef.current) {
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

      states.forEach((st: {
        isHost?: boolean;
        user?: { id: string; name: string; color: string };
        cursor?: { x: number; y: number };
        assetRequests?: string[];
        assetResponse?: { uuid: string; data: string; mimeType: string };
      }, clientId: number) => {
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
      knownPeersRef.current.forEach((name: string, clientId: number) => {
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
        setReceivedAssets((prev: Map<string, { data: string; mimeType: string }>) => {
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
      // ydoc は別 useEffect で管理するためここでは破棄しない
    };
  }, [roomId, enabled, isHost]); // initialEvents は ref 経由で参照

  // イベント追加
  const addDrawEvent = useCallback((event: DrawEvent) => {
    if (!yEventsRef.current) return;
    const e = { ...event, sessionId: event.sessionId || sessionIdRef.current };
    yEventsRef.current.push([e]);
    setUndoStack((prev: Operation[]) => [...prev, { type: 'draw', strokeId: e.id, strokeData: e }]);
    setRedoStack((_prev: Operation[]) => []);
  }, []);

  const addEraseEvent = useCallback((event: EraseEvent, targetStrokes: DrawEvent[]) => {
    if (!yEventsRef.current) return;
    const e = { ...event, sessionId: event.sessionId || sessionIdRef.current };
    yEventsRef.current.push([e]);
    setUndoStack((prev: Operation[]) => [...prev, { type: 'erase', eraseId: e.id, targetIds: e.targetIds, targetStrokes }]);
    setRedoStack((_prev: Operation[]) => []);
  }, []);

  // オーバーレイ追加
  const addOverlayEvent = useCallback((event: OverlayAddEvent) => {
    if (!yEventsRef.current) return;
    const e = { ...event, sessionId: event.sessionId || sessionIdRef.current };
    yEventsRef.current.push([e]);
    setUndoStack((prev: Operation[]) => [...prev, { type: 'overlayAdd', overlayId: e.overlayId, overlayData: e }]);
    setRedoStack((_prev: Operation[]) => []);
  }, []);

  // アセットをリクエスト（ゲスト用）
  const requestAsset = useCallback((uuid: string) => {
    const a = providerRef.current?.awareness;
    if (!a) return;
    
    // 既にリクエスト中ならスキップ
    if (pendingAssetRequests.has(uuid)) return;
    
    setPendingAssetRequests((prev: Set<string>) => new Set(prev).add(uuid));
    
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
    
    setPendingAssetRequests((prev: Set<string>) => {
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
    setUndoStack((prev: Operation[]) => [...prev, { 
      type: 'overlayRemove', 
      removeId: e.removeId, 
      targetOverlayIds: e.targetOverlayIds,
      targetOverlays 
    }]);
    setRedoStack((_prev: Operation[]) => []);
  }, []);

  // オーバーレイ移動/リサイズ（差分記録）
  const transformOverlayEvent = useCallback((
    event: OverlayTransformEvent,
    before: Partial<{ x: number; y: number; width: number; height: number; rotation: number }>
  ) => {
    if (!yEventsRef.current) return;
    const e = { ...event, sessionId: event.sessionId || sessionIdRef.current };
    yEventsRef.current.push([e]);
    // after は event に存在するフィールドのみ
    const after: typeof before = {};
    if (e.x        !== undefined) after.x        = e.x;
    if (e.y        !== undefined) after.y        = e.y;
    if (e.width    !== undefined) after.width    = e.width;
    if (e.height   !== undefined) after.height   = e.height;
    if (e.rotation !== undefined) after.rotation = e.rotation;
    setUndoStack((prev: Operation[]) => [...prev, {
      type: 'overlayTransform',
      overlayId: e.overlayId,
      before,
      after,
    }]);
    setRedoStack((_prev: Operation[]) => []);
  }, []);

  // オーバーレイ viewport 変更（差分記録）
  const viewportOverlayEvent = useCallback((
    event: OverlayViewportEvent,
    before: Partial<{ viewport: { x: number; y: number; width: number; height: number }; page: number }>
  ) => {
    if (!yEventsRef.current) return;
    const e = { ...event, sessionId: event.sessionId || sessionIdRef.current };
    yEventsRef.current.push([e]);
    const after: typeof before = {};
    if (e.viewport !== undefined) after.viewport = e.viewport;
    if (e.page     !== undefined) after.page     = e.page;
    setUndoStack((prev: Operation[]) => [...prev, {
      type: 'overlayViewport',
      overlayId: e.overlayId,
      before,
      after,
    }]);
    setRedoStack((_prev: Operation[]) => []);
  }, []);

  // オーバーレイ style 変更（複数ターゲット・差分記録）
  const styleOverlayEvent = useCallback((
    event: OverlayStyleEvent,
    befores: Array<{ overlayId: string; before: Partial<{ zIndex: number; opacity: number }> }>
  ) => {
    if (!yEventsRef.current) return;
    const e = { ...event, sessionId: event.sessionId || sessionIdRef.current };
    yEventsRef.current.push([e]);
    // changes: before/after を overlayId でペアリング
    const changes = befores.map(({ overlayId, before }) => {
      const target = e.targets.find(t => t.overlayId === overlayId);
      const after: Partial<{ zIndex: number; opacity: number }> = {};
      if (target?.zIndex  !== undefined) after.zIndex  = target.zIndex;
      if (target?.opacity !== undefined) after.opacity = target.opacity;
      return { overlayId, before, after };
    });
    setUndoStack((prev: Operation[]) => [...prev, { type: 'overlayStyle', changes }]);
    setRedoStack((_prev: Operation[]) => []);
  }, []);

  // 投げ縄: ストローク移動（元ストロークを E で消去 + 移動後ストロークを D で追加）
  const lassoMoveStrokes = useCallback((originalStrokes: DrawEvent[], movedStrokes: DrawEvent[]) => {
    if (!yEventsRef.current || originalStrokes.length === 0) return;
    const sid = sessionIdRef.current;
    const ts = getTimestamp();

    // 元ストロークを消去
    const eraseId = generateEraseId();
    yEventsRef.current.push([{
      type: 'E',
      timestamp: ts,
      sessionId: sid,
      id: eraseId,
      targetIds: originalStrokes.map(s => s.id),
    }]);

    // 移動後ストロークを追加
    for (const stroke of movedStrokes) {
      yEventsRef.current.push([{ ...stroke, timestamp: ts, sessionId: sid }]);
    }

    setUndoStack((prev: Operation[]) => [...prev, {
      type: 'lassoMove',
      eraseId,
      originalStrokes,
      newStrokes: movedStrokes,
    } as LassoMoveOperation]);
    setRedoStack((_prev: Operation[]) => []);
  }, []);

  // 投げ縄: ストローク削除
  const lassoDeleteStrokes = useCallback((strokes: DrawEvent[]) => {
    if (!yEventsRef.current || strokes.length === 0) return;
    const sid = sessionIdRef.current;
    const eraseId = generateEraseId();
    yEventsRef.current.push([{
      type: 'E',
      timestamp: getTimestamp(),
      sessionId: sid,
      id: eraseId,
      targetIds: strokes.map(s => s.id),
    }]);
    setUndoStack((prev: Operation[]) => [...prev, {
      type: 'erase',
      eraseId,
      targetIds: strokes.map(s => s.id),
      targetStrokes: strokes,
    }]);
    setRedoStack((_prev: Operation[]) => []);
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
      // 変更されたフィールドのみ before 値で戻す
      yEventsRef.current.push([{
        type: 'OT',
        timestamp: getTimestamp(),
        sessionId: sessionIdRef.current,
        overlayId: op.overlayId,
        ...op.before,
      }]);
    } else if (op.type === 'overlayViewport') {
      yEventsRef.current.push([{
        type: 'OV',
        timestamp: getTimestamp(),
        sessionId: sessionIdRef.current,
        overlayId: op.overlayId,
        ...op.before,
      }]);
    } else if (op.type === 'overlayStyle') {
      // 全 change の before を OS 1本で戻す
      yEventsRef.current.push([{
        type: 'OS',
        timestamp: getTimestamp(),
        sessionId: sessionIdRef.current,
        targets: op.changes.map((c: { overlayId: string; before: Partial<{ zIndex: number; opacity: number }> }) => ({ overlayId: c.overlayId, ...c.before })),
      }]);
    } else if (op.type === 'lassoMove') {
      // 移動後ストロークを消去 → 元ストロークを復元
      yEventsRef.current.push([{
        type: 'E',
        timestamp: getTimestamp(),
        sessionId: sessionIdRef.current,
        id: generateEraseId(),
        targetIds: op.newStrokes.map((s: DrawEvent) => s.id),
      }]);
      for (const stroke of op.originalStrokes) {
        yEventsRef.current.push([{ ...stroke, timestamp: getTimestamp(), sessionId: sessionIdRef.current }]);
      }
    }

    setUndoStack((prev: Operation[]) => prev.slice(0, -1));
    setRedoStack((prev: Operation[]) => [...prev, op]);
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
      yEventsRef.current.push([{
        type: 'OT',
        timestamp: getTimestamp(),
        sessionId: sessionIdRef.current,
        overlayId: op.overlayId,
        ...op.after,
      }]);
    } else if (op.type === 'overlayViewport') {
      yEventsRef.current.push([{
        type: 'OV',
        timestamp: getTimestamp(),
        sessionId: sessionIdRef.current,
        overlayId: op.overlayId,
        ...op.after,
      }]);
    } else if (op.type === 'overlayStyle') {
      yEventsRef.current.push([{
        type: 'OS',
        timestamp: getTimestamp(),
        sessionId: sessionIdRef.current,
        targets: op.changes.map((c: { overlayId: string; after: Partial<{ zIndex: number; opacity: number }> }) => ({ overlayId: c.overlayId, ...c.after })),
      }]);
    } else if (op.type === 'lassoMove') {
      // 元ストロークを消去 → 移動後ストロークを復元
      yEventsRef.current.push([{
        type: 'E',
        timestamp: getTimestamp(),
        sessionId: sessionIdRef.current,
        id: generateEraseId(),
        targetIds: op.originalStrokes.map((s: DrawEvent) => s.id),
      }]);
      for (const stroke of op.newStrokes) {
        yEventsRef.current.push([{ ...stroke, timestamp: getTimestamp(), sessionId: sessionIdRef.current }]);
      }
    }

    setRedoStack((prev: Operation[]) => prev.slice(0, -1));
    setUndoStack((prev: Operation[]) => [...prev, op]);
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
    
    const h = generateSnapshotHash();
    return createSnapshot(snaps, h);
  }, [state]);

  // state が変わらない限り同じ参照を返す（BoardEditor の useEffect 無限ループ防止）
  const activeStrokes = useMemo(() => getActiveStrokes(state), [state]);
  const activeOverlays = useMemo(() => getActiveOverlays(state), [state]);

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
    activeStrokes,
    activeOverlays,
    cursors,
    addDrawEvent,
    addEraseEvent,
    addOverlayEvent,
    removeOverlayEvent,
    transformOverlayEvent,
    viewportOverlayEvent,
    styleOverlayEvent,
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
    // 投げ縄
    lassoMoveStrokes,
    lassoDeleteStrokes,
  };
}
