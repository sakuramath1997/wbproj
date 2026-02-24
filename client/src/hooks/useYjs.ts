/**
 * useYjs — P2P コラボレーションフック (v4)
 *
 * v4 変更点:
 * - BATCH イベントによるアトミックグループ化
 * - 全イベント型の UndoStack 復元（0-B-2 完了）
 * - 単一対象 E / OR / OS
 * - Local Undo（sessionId フィルタリング）
 * - Session ID のプロジェクト単位永続化（0-C-2 完了）
 */

import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import * as Y from 'yjs';
import { WebrtcProvider } from 'y-webrtc';
import type {
  WbelxEvent,
  SubEvent,
  DrawEvent,
  EraseEvent,
  CursorInfo,
  WbelxState,
  OverlayAddEvent,
  OverlayRemoveEvent,
  OverlayTransformEvent,
  OverlayViewportEvent,
  OverlayStyleEvent,
  BackgroundEvent,
  CanvasSizeEvent,
  BatchEvent,
  OverlayState,
  Operation,
  SingleOperation,
  ViewportDelta,
} from '../types';
import { computeState, applyEvent, getActiveStrokes, getActiveOverlays } from '../utils/statemachine';
import {
  generateEraseId, generateRemoveId, generateTransformOpId, generateViewportOpId,
  generateStyleOpId, generateBgOpId, generateBatchId,
  generateStrokeId, generateOverlayId,
  getTimestamp, getOrCreateSessionId, generateSnapshotHash,
} from '../utils/common';
import { eventsToWbelx, createSnapshot } from '../utils/wbelx-parser';

// ========================================
// シグナリング・ICE 設定
// ========================================

const getSignalingServers = (): string[] => {
  if (import.meta.env.VITE_SIGNALING_URL) return [import.meta.env.VITE_SIGNALING_URL];
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.hostname;
  return [`${protocol}//${host}:4444`];
};

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

// ========================================
// ランダムユーザー情報
// ========================================

const getRandomColor = () => ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899'][Math.floor(Math.random() * 7)];
const getRandomName = () => {
  const adj = ['Swift', 'Bright', 'Calm', 'Bold', 'Keen'];
  const noun = ['Fox', 'Bear', 'Wolf', 'Owl', 'Deer'];
  return adj[Math.floor(Math.random() * 5)] + noun[Math.floor(Math.random() * 5)];
};

// ========================================
// Undo/Redo ヘルパー: 逆操作・再実行イベント生成
// ========================================

/** SVG パス文字列を dx, dy だけオフセットする */
function offsetSvgPathSimple(path: string, dx: number, dy: number): string {
  let idx = 0;
  return path.replace(/-?[\d.]+/g, (match) => {
    const val = parseFloat(match);
    const isX = idx % 2 === 0;
    idx++;
    return String(Math.round((val + (isX ? dx : dy)) * 100) / 100);
  });
}

/** SingleOperation の逆操作サブイベントを生成（Undo 時） */
function createUndoSubEvent(op: SingleOperation, ts: string, sid: string): SubEvent {
  switch (op.type) {
    case 'draw':
      return { type: 'E', timestamp: ts, sessionId: sid, id: generateEraseId(), targetId: op.strokeId };
    case 'erase':
      return { ...op.targetStroke, timestamp: ts, sessionId: sid };
    case 'overlayAdd':
      return { type: 'OR', timestamp: ts, sessionId: sid, removeId: generateRemoveId(), targetOverlayId: op.overlayId };
    case 'overlayRemove':
      return { ...op.targetOverlay, timestamp: ts, sessionId: sid };
    case 'overlayTransform':
      return {
        type: 'OT', timestamp: ts, sessionId: sid, id: generateTransformOpId(), overlayId: op.overlayId,
        ...(op.dx !== 0 && { dx: -op.dx }), ...(op.dy !== 0 && { dy: -op.dy }),
        ...(op.dWidth !== 0 && { dWidth: -op.dWidth }), ...(op.dHeight !== 0 && { dHeight: -op.dHeight }),
        ...(op.dRotation !== 0 && { dRotation: -op.dRotation }),
      };
    case 'overlayViewport':
      return {
        type: 'OV', timestamp: ts, sessionId: sid, id: generateViewportOpId(), overlayId: op.overlayId,
        ...(op.dViewport && {
          dViewport: {
            ...(op.dViewport.dx !== undefined && { dx: -op.dViewport.dx }),
            ...(op.dViewport.dy !== undefined && { dy: -op.dViewport.dy }),
            ...(op.dViewport.dWidth !== undefined && { dWidth: -op.dViewport.dWidth }),
            ...(op.dViewport.dHeight !== undefined && { dHeight: -op.dViewport.dHeight }),
          },
        }),
        ...(op.dPage !== undefined && { dPage: -op.dPage }),
      };
    case 'overlayStyle':
      return {
        type: 'OS', timestamp: ts, sessionId: sid, id: generateStyleOpId(), overlayId: op.overlayId,
        ...(op.dzIndex !== undefined && { dzIndex: -op.dzIndex }),
        ...(op.dOpacity !== undefined && { dOpacity: -op.dOpacity }),
      };
    case 'background':
      return {
        type: 'BG', timestamp: ts, sessionId: sid, id: generateBgOpId(),
        ...(op.dColor && { dColor: { space: 'srgb' as const, dr: -op.dColor.dr, dg: -op.dColor.dg, db: -op.dColor.db } }),
        ...(op.pattern && { pattern: { prev: op.pattern.next, next: op.pattern.prev } }),
        ...(op.dPatternSize !== undefined && { dPatternSize: -op.dPatternSize }),
        ...(op.dPatternColor && { dPatternColor: { space: 'srgb' as const, dr: -op.dPatternColor.dr, dg: -op.dPatternColor.dg, db: -op.dPatternColor.db } }),
      };
    case 'canvasSize':
      return {
        type: 'CS', timestamp: ts, sessionId: sid, id: `cs:${Math.random().toString(36).slice(2, 14)}`,
        ...(op.dCanvasWidth !== undefined && { dCanvasWidth: -op.dCanvasWidth }),
        ...(op.dCanvasHeight !== undefined && { dCanvasHeight: -op.dCanvasHeight }),
      };
  }
}

/** SingleOperation の再実行サブイベントを生成（Redo 時） */
function createRedoSubEvent(op: SingleOperation, ts: string, sid: string): SubEvent {
  switch (op.type) {
    case 'draw':
      return { ...op.strokeData, timestamp: ts, sessionId: sid };
    case 'erase':
      return { type: 'E', timestamp: ts, sessionId: sid, id: generateEraseId(), targetId: op.targetId };
    case 'overlayAdd':
      return { ...op.overlayData, timestamp: ts, sessionId: sid };
    case 'overlayRemove':
      return { type: 'OR', timestamp: ts, sessionId: sid, removeId: generateRemoveId(), targetOverlayId: op.targetOverlayId };
    case 'overlayTransform':
      return {
        type: 'OT', timestamp: ts, sessionId: sid, id: generateTransformOpId(), overlayId: op.overlayId,
        ...(op.dx !== 0 && { dx: op.dx }), ...(op.dy !== 0 && { dy: op.dy }),
        ...(op.dWidth !== 0 && { dWidth: op.dWidth }), ...(op.dHeight !== 0 && { dHeight: op.dHeight }),
        ...(op.dRotation !== 0 && { dRotation: op.dRotation }),
      };
    case 'overlayViewport':
      return {
        type: 'OV', timestamp: ts, sessionId: sid, id: generateViewportOpId(), overlayId: op.overlayId,
        ...(op.dViewport && { dViewport: op.dViewport }),
        ...(op.dPage !== undefined && { dPage: op.dPage }),
      };
    case 'overlayStyle':
      return {
        type: 'OS', timestamp: ts, sessionId: sid, id: generateStyleOpId(), overlayId: op.overlayId,
        ...(op.dzIndex !== undefined && { dzIndex: op.dzIndex }),
        ...(op.dOpacity !== undefined && { dOpacity: op.dOpacity }),
      };
    case 'background':
      return {
        type: 'BG', timestamp: ts, sessionId: sid, id: generateBgOpId(),
        ...(op.dColor && { dColor: op.dColor }),
        ...(op.pattern && { pattern: op.pattern }),
        ...(op.dPatternSize !== undefined && { dPatternSize: op.dPatternSize }),
        ...(op.dPatternColor && { dPatternColor: op.dPatternColor }),
      };
    case 'canvasSize':
      return {
        type: 'CS', timestamp: ts, sessionId: sid, id: `cs:${Math.random().toString(36).slice(2, 14)}`,
        ...(op.dCanvasWidth !== undefined && { dCanvasWidth: op.dCanvasWidth }),
        ...(op.dCanvasHeight !== undefined && { dCanvasHeight: op.dCanvasHeight }),
      };
  }
}

// ========================================
// UndoStack 復元: 外部モジュールから import
// ========================================

import { buildUndoStack, buildUndoStackAsync } from '../utils/undo-stack';

/**
 * イベント数がこの閾値以下なら同期版で即座に構築。
 * 超える場合は非同期チャンク版でバックグラウンド構築する。
 */
const LAZY_BUILD_THRESHOLD = 1000;

// ========================================
// フック型定義
// ========================================

export interface UseYjsOptions {
  roomId: string;
  enabled?: boolean;
  isHost?: boolean;
  initialEvents?: WbelxEvent[];
  projectUuid?: string;
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
  // ストローク
  addDrawEvent: (event: DrawEvent) => void;
  eraseStrokes: (targetStrokes: DrawEvent[]) => void;
  // オーバーレイ
  addOverlayEvent: (event: OverlayAddEvent) => void;
  removeOverlay: (overlayId: string) => void;
  transformOverlayEvent: (
    overlayId: string,
    before: { x: number; y: number; width: number; height: number; rotation: number },
    after: { x: number; y: number; width: number; height: number; rotation: number },
  ) => void;
  viewportOverlayEvent: (
    overlayId: string,
    before: { viewport: { x: number; y: number; width: number; height: number }; page: number },
    after: { viewport: { x: number; y: number; width: number; height: number }; page: number },
  ) => void;
  styleOverlays: (
    targets: Array<{ overlayId: string; before: { zIndex: number; opacity: number }; after: { zIndex: number; opacity: number } }>,
  ) => void;
  // 背景・キャンバス
  addBackgroundEvent: (event: BackgroundEvent) => void;
  addCanvasSizeEvent: (event: CanvasSizeEvent) => void;
  // 投げ縄
  lassoMoveSelection: (
    originalStrokes: DrawEvent[], movedStrokes: DrawEvent[],
    overlayDeltas: Array<{overlayId: string; dx: number; dy: number}>,
  ) => void;
  lassoDeleteSelection: (strokes: DrawEvent[], overlayIds: string[]) => void;
  lassoDuplicateSelection: (
    strokes: DrawEvent[], overlays: OverlayState[],
    dx: number, dy: number,
  ) => { newStrokeIds: string[]; newOverlayIds: string[] };
  lassoPasteSelection: (
    strokes: DrawEvent[], overlays: OverlayState[],
    dx: number, dy: number,
  ) => { newStrokeIds: string[]; newOverlayIds: string[] };
  // Undo/Redo
  performUndo: () => void;
  performRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  undoStackReady: boolean;
  // カーソル
  updateCursor: (x: number, y: number) => void;
  hideCursor: () => void;
  // メタ
  sessionId: string;
  userId: string;
  userColor: string;
  exportWbelx: () => string;
  exportSnapshotWbelx: () => string;
  hasContent: boolean;
  provider: WebrtcProvider | null;
}

// ========================================
// メインフック
// ========================================

export function useYjs({
  roomId,
  enabled = true,
  isHost = false,
  initialEvents = [],
  projectUuid,
  onPeerJoin,
  onPeerLeave,
}: UseYjsOptions): UseYjsReturn {
  // ---- 接続状態 ----
  const [isConnected, setIsConnected] = useState(false);
  const [signalingConnected, setSignalingConnected] = useState(false);
  const [peerCount, setPeerCount] = useState(0);
  const [isHostConnected, setIsHostConnected] = useState(isHost);
  const [guestsPresent, setGuestsPresent] = useState(false);
  const [isJoiningRoom, setIsJoiningRoom] = useState(true);
  const [peerSearchTimedOut, setPeerSearchTimedOut] = useState(false);
  const [hasSyncedData, setHasSyncedData] = useState(false);

  // ---- データ ----
  const [events, setEvents] = useState<WbelxEvent[]>([]);
  const [state, setState] = useState<WbelxState>(() => computeState([]));
  const [cursors, setCursors] = useState<Map<string, CursorInfo>>(new Map());
  const [undoStack, setUndoStack] = useState<Operation[]>([]);
  const [redoStack, setRedoStack] = useState<Operation[]>([]);
  const [undoStackReady, setUndoStackReady] = useState(false);
  const [activeProvider, setActiveProvider] = useState<WebrtcProvider | null>(null);

  // ---- Refs ----
  const ydocRef = useRef<Y.Doc | null>(null);
  const providerRef = useRef<WebrtcProvider | null>(null);
  const yEventsRef = useRef<Y.Array<WbelxEvent> | null>(null);
  const sessionIdRef = useRef(getOrCreateSessionId(projectUuid));
  const userIdRef = useRef(`user:${Math.random().toString(36).slice(2, 10)}`);
  const userColorRef = useRef(getRandomColor());
  const userNameRef = useRef(getRandomName());
  const initialLoadedRef = useRef(false);
  const stateRef = useRef<WbelxState>(computeState([]));
  const undoBuildAbortRef = useRef<AbortController | null>(null);
  const p2pActiveRef = useRef(false);
  const lastKnownLengthRef = useRef(0);
  const knownPeersRef = useRef<Map<number, string>>(new Map());
  const onPeerJoinRef = useRef(onPeerJoin);
  const onPeerLeaveRef = useRef(onPeerLeave);
  const initialEventsRef = useRef(initialEvents);

  useEffect(() => { onPeerJoinRef.current = onPeerJoin; onPeerLeaveRef.current = onPeerLeave; }, [onPeerJoin, onPeerLeave]);
  useEffect(() => { initialEventsRef.current = initialEvents; }, [initialEvents]);

  // ---- インクリメンタル状態計算 ----
  const recomputeState = useCallback((all: WbelxEvent[], isLocal: boolean) => {
    if (isLocal && all.length > lastKnownLengthRef.current) {
      let s = stateRef.current;
      for (let i = lastKnownLengthRef.current; i < all.length; i++) {
        s = applyEvent(s, all[i]);
      }
      stateRef.current = s;
    } else {
      stateRef.current = computeState(all);
    }
    lastKnownLengthRef.current = all.length;
    setState(stateRef.current);
  }, []);

  // ---- UndoStack 構築（同期/非同期を自動選択） ----
  const startUndoStackBuild = useCallback((evts: WbelxEvent[]) => {
    // 進行中の非同期ビルドをキャンセル
    if (undoBuildAbortRef.current) {
      undoBuildAbortRef.current.abort();
      undoBuildAbortRef.current = null;
    }

    const sid = sessionIdRef.current;

    if (evts.length <= LAZY_BUILD_THRESHOLD) {
      // 同期版で即座に構築
      setUndoStack(buildUndoStack(evts, sid));
      setUndoStackReady(true);
    } else {
      // 非同期チャンク版でバックグラウンド構築
      setUndoStackReady(false);
      const controller = new AbortController();
      undoBuildAbortRef.current = controller;
      buildUndoStackAsync(evts, sid, { signal: controller.signal })
        .then(stack => {
          if (!controller.signal.aborted) {
            setUndoStack(stack);
            setUndoStackReady(true);
            undoBuildAbortRef.current = null;
          }
        });
    }
  }, []);

  // ---- 初期イベントロード + UndoStack 復元 ----
  const loadInitialEvents = useCallback((yEvents: Y.Array<WbelxEvent>, ydoc: Y.Doc) => {
    if (initialLoadedRef.current) return;
    const current = yEvents.toArray();
    if (current.length > 0) {
      initialLoadedRef.current = true;
      startUndoStackBuild(current);
      return;
    }
    if (initialEventsRef.current.length > 0) {
      ydoc.transact(() => {
        for (const e of initialEventsRef.current) yEvents.push([e]);
      });
      startUndoStackBuild(initialEventsRef.current);
    }
    initialLoadedRef.current = true;
  }, [startUndoStackBuild]);

  // ---- Y.Doc 初期化 ----
  useEffect(() => {
    const ydoc = new Y.Doc();
    ydocRef.current = ydoc;
    const yEvents = ydoc.getArray<WbelxEvent>('events');
    yEventsRef.current = yEvents;

    const observeLocal = (_event: Y.YArrayEvent<WbelxEvent>, transaction: Y.Transaction) => {
      const all = yEvents.toArray();
      setEvents(all);
      if (!p2pActiveRef.current) recomputeState(all, transaction.local);
    };
    yEvents.observe(observeLocal);

    if (isHost && initialEventsRef.current.length > 0) {
      loadInitialEvents(yEvents, ydoc);
    }

    return () => {
      yEvents.unobserve(observeLocal);
      // 進行中の非同期ビルドをキャンセル
      if (undoBuildAbortRef.current) {
        undoBuildAbortRef.current.abort();
        undoBuildAbortRef.current = null;
      }
      ydoc.destroy();
      ydocRef.current = null;
      yEventsRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- WebRTC Provider ----
  useEffect(() => {
    if (!enabled || !roomId) return;
    const ydoc = ydocRef.current;
    const yEvents = yEventsRef.current;
    if (!ydoc || !yEvents) return;

    setIsJoiningRoom(true);
    setPeerSearchTimedOut(false);
    setHasSyncedData(false);
    setIsHostConnected(isHost);
    setGuestsPresent(false);
    initialLoadedRef.current = false;

    const provider = new WebrtcProvider(roomId, ydoc, {
      signaling: getSignalingServers(),
      peerOpts: { iceServers: getIceServers() },
    });
    providerRef.current = provider;
    setActiveProvider(provider);

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const startTimeout = () => {
      if (isHost) {
        timeoutId = setTimeout(() => { loadInitialEvents(yEvents, ydoc); setIsJoiningRoom(false); }, 500);
      } else {
        timeoutId = setTimeout(() => {
          if (yEvents.toArray().length === 0) setPeerSearchTimedOut(true);
          setIsJoiningRoom(false);
        }, 5000);
      }
    };
    const clearTimeoutIfSet = () => { if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; } };

    provider.on('status', ({ connected }: { connected: boolean }) => {
      setSignalingConnected(connected);
      if (connected) { setIsConnected(true); startTimeout(); }
    });

    provider.on('synced', ({ synced }: { synced: boolean }) => {
      if (synced) {
        const current = yEvents.toArray();
        if (current.length > 0) { setHasSyncedData(true); clearTimeoutIfSet(); setIsJoiningRoom(false); }
        if (isHost && !initialLoadedRef.current) loadInitialEvents(yEvents, ydoc);
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
      const currentPeers = new Map<number, string>();

      states.forEach((st: { isHost?: boolean; user?: { id: string; name: string; color: string }; cursor?: { x: number; y: number } }, clientId: number) => {
        if (clientId === awareness.clientID) return;
        count++;
        if (st.isHost) foundHost = true; else foundGuests = true;
        const peerName = st.user?.name || 'Unknown';
        currentPeers.set(clientId, peerName);
        if (st.user && st.cursor) {
          newCursors.set(st.user.id, { id: st.user.id, name: st.user.name, x: st.cursor.x, y: st.cursor.y, color: st.user.color });
        }
      });

      currentPeers.forEach((name, clientId) => { if (!knownPeersRef.current.has(clientId)) onPeerJoinRef.current?.(name); });
      knownPeersRef.current.forEach((name: string, clientId: number) => { if (!currentPeers.has(clientId)) onPeerLeaveRef.current?.(name); });
      knownPeersRef.current = currentPeers;

      setCursors(newCursors);
      setPeerCount(count);
      setIsHostConnected(foundHost);
      if (foundGuests) { setGuestsPresent(true); clearTimeoutIfSet(); setIsJoiningRoom(false); }
    };
    awareness.on('change', updateAwareness);
    updateAwareness();

    // P2P observer
    p2pActiveRef.current = true;
    const observeEvents = (_event: Y.YArrayEvent<WbelxEvent>, transaction: Y.Transaction) => {
      const all = yEvents.toArray();
      setEvents(all);
      recomputeState(all, transaction.local);
    };
    yEvents.observe(observeEvents);
    { const all = yEvents.toArray(); setEvents(all); recomputeState(all, false); }

    return () => {
      clearTimeoutIfSet();
      awareness.off('change', updateAwareness);
      yEvents.unobserve(observeEvents);
      p2pActiveRef.current = false;
      const all = yEvents.toArray();
      recomputeState(all, false);
      provider.destroy();
      setActiveProvider(null);
    };
  }, [roomId, enabled, isHost, loadInitialEvents, recomputeState]);

  // ========================================
  // イベント発行 & Operation 登録ヘルパー
  // ========================================

  const pushEvent = useCallback((event: WbelxEvent) => {
    yEventsRef.current?.push([event]);
  }, []);

  const pushOp = useCallback((op: Operation) => {
    // ユーザー操作が入った場合、進行中の非同期ビルドをキャンセルして即座に ready にする
    if (undoBuildAbortRef.current) {
      undoBuildAbortRef.current.abort();
      undoBuildAbortRef.current = null;
      setUndoStackReady(true);
    }
    setUndoStack(prev => [...prev, op]);
    setRedoStack(() => []);
  }, []);

  // ========================================
  // ストローク操作
  // ========================================

  const addDrawEvent = useCallback((event: DrawEvent) => {
    const e = { ...event, sessionId: event.sessionId || sessionIdRef.current };
    pushEvent(e);
    pushOp({ type: 'draw', strokeId: e.id, strokeData: e });
  }, [pushEvent, pushOp]);

  /** 複数ストロークの消去。1本なら単独 E、2本以上なら BATCH。 */
  const eraseStrokes = useCallback((targetStrokes: DrawEvent[]) => {
    if (!yEventsRef.current || targetStrokes.length === 0) return;
    const ts = getTimestamp();
    const sid = sessionIdRef.current;

    if (targetStrokes.length === 1) {
      const e: EraseEvent = { type: 'E', timestamp: ts, sessionId: sid, id: generateEraseId(), targetId: targetStrokes[0].id };
      pushEvent(e);
      pushOp({ type: 'erase', eraseId: e.id, targetId: e.targetId, targetStroke: targetStrokes[0] });
    } else {
      const subEvents: SubEvent[] = [];
      const ops: SingleOperation[] = [];
      for (const stroke of targetStrokes) {
        const eid = generateEraseId();
        subEvents.push({ type: 'E', timestamp: ts, sessionId: sid, id: eid, targetId: stroke.id });
        ops.push({ type: 'erase', eraseId: eid, targetId: stroke.id, targetStroke: stroke });
      }
      const batch: BatchEvent = { type: 'BATCH', id: generateBatchId(), timestamp: ts, sessionId: sid, events: subEvents };
      pushEvent(batch);
      pushOp({ type: 'batch', batchId: batch.id, operations: ops });
    }
  }, [pushEvent, pushOp]);

  // ========================================
  // オーバーレイ操作
  // ========================================

  const addOverlayEvent = useCallback((event: OverlayAddEvent) => {
    const e = { ...event, sessionId: event.sessionId || sessionIdRef.current };
    pushEvent(e);
    pushOp({ type: 'overlayAdd', overlayId: e.overlayId, overlayData: e });
  }, [pushEvent, pushOp]);

  const removeOverlay = useCallback((overlayId: string) => {
    if (!yEventsRef.current) return;
    // 現在のオーバーレイ状態を取得（Undo 用）
    const overlay = stateRef.current.overlays.get(overlayId);
    if (!overlay) return;
    const targetOverlay: OverlayAddEvent = {
      type: 'OA', timestamp: '', sessionId: '',
      overlayId: overlay.overlayId, assetUuid: overlay.assetUuid,
      x: overlay.x, y: overlay.y, width: overlay.width, height: overlay.height,
      rotation: overlay.rotation, viewport: overlay.viewport,
      page: overlay.page, zIndex: overlay.zIndex, opacity: overlay.opacity,
    };
    const e: OverlayRemoveEvent = {
      type: 'OR', timestamp: getTimestamp(), sessionId: sessionIdRef.current,
      removeId: generateRemoveId(), targetOverlayId: overlayId,
    };
    pushEvent(e);
    pushOp({ type: 'overlayRemove', removeId: e.removeId, targetOverlayId: overlayId, targetOverlay });
  }, [pushEvent, pushOp]);

  const transformOverlayEvent = useCallback((
    overlayId: string,
    before: { x: number; y: number; width: number; height: number; rotation: number },
    after: { x: number; y: number; width: number; height: number; rotation: number },
  ) => {
    if (!yEventsRef.current) return;
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    const dWidth = after.width - before.width;
    const dHeight = after.height - before.height;
    const dRotation = after.rotation - before.rotation;
    const opId = generateTransformOpId();
    const e: OverlayTransformEvent = {
      type: 'OT', timestamp: getTimestamp(), sessionId: sessionIdRef.current, id: opId, overlayId,
      ...(dx !== 0 && { dx }), ...(dy !== 0 && { dy }),
      ...(dWidth !== 0 && { dWidth }), ...(dHeight !== 0 && { dHeight }),
      ...(dRotation !== 0 && { dRotation }),
    };
    pushEvent(e);
    pushOp({ type: 'overlayTransform', id: opId, overlayId, dx, dy, dWidth, dHeight, dRotation });
  }, [pushEvent, pushOp]);

  const viewportOverlayEvent = useCallback((
    overlayId: string,
    before: { viewport: { x: number; y: number; width: number; height: number }; page: number },
    after: { viewport: { x: number; y: number; width: number; height: number }; page: number },
  ) => {
    if (!yEventsRef.current) return;
    const opId = generateViewportOpId();
    const dvp: ViewportDelta = {};
    const dxVp = after.viewport.x - before.viewport.x;
    const dyVp = after.viewport.y - before.viewport.y;
    const dwVp = after.viewport.width - before.viewport.width;
    const dhVp = after.viewport.height - before.viewport.height;
    if (dxVp !== 0) dvp.dx = dxVp;
    if (dyVp !== 0) dvp.dy = dyVp;
    if (dwVp !== 0) dvp.dWidth = dwVp;
    if (dhVp !== 0) dvp.dHeight = dhVp;
    const hasVpDelta = Object.keys(dvp).length > 0;
    const dPage = after.page - before.page;
    const e: OverlayViewportEvent = {
      type: 'OV', timestamp: getTimestamp(), sessionId: sessionIdRef.current, id: opId, overlayId,
      ...(hasVpDelta && { dViewport: dvp }),
      ...(dPage !== 0 && { dPage }),
    };
    pushEvent(e);
    pushOp({
      type: 'overlayViewport', id: opId, overlayId,
      ...(hasVpDelta && { dViewport: dvp }),
      ...(dPage !== 0 && { dPage }),
    });
  }, [pushEvent, pushOp]);

  /**
   * OS スタイル変更。1ターゲットなら単独 OS、2+ターゲットなら BATCH。
   * zIndex スワップ等で複数ターゲットが必要なケースに対応。
   */
  const styleOverlays = useCallback((
    targets: Array<{ overlayId: string; before: { zIndex: number; opacity: number }; after: { zIndex: number; opacity: number } }>,
  ) => {
    if (!yEventsRef.current || targets.length === 0) return;
    const ts = getTimestamp();
    const sid = sessionIdRef.current;

    if (targets.length === 1) {
      const t = targets[0];
      const dzIndex = t.after.zIndex - t.before.zIndex;
      const dOpacity = t.after.opacity - t.before.opacity;
      const opId = generateStyleOpId();
      const e: OverlayStyleEvent = {
        type: 'OS', timestamp: ts, sessionId: sid, id: opId, overlayId: t.overlayId,
        ...(dzIndex !== 0 && { dzIndex }),
        ...(Math.abs(dOpacity) > 1e-9 && { dOpacity }),
      };
      pushEvent(e);
      pushOp({
        type: 'overlayStyle', id: opId, overlayId: t.overlayId,
        ...(dzIndex !== 0 && { dzIndex }),
        ...(Math.abs(dOpacity) > 1e-9 && { dOpacity }),
      });
    } else {
      const subEvents: SubEvent[] = [];
      const ops: SingleOperation[] = [];
      for (const t of targets) {
        const dzIndex = t.after.zIndex - t.before.zIndex;
        const dOpacity = t.after.opacity - t.before.opacity;
        const opId = generateStyleOpId();
        const sub: OverlayStyleEvent = {
          type: 'OS', timestamp: ts, sessionId: sid, id: opId, overlayId: t.overlayId,
          ...(dzIndex !== 0 && { dzIndex }),
          ...(Math.abs(dOpacity) > 1e-9 && { dOpacity }),
        };
        subEvents.push(sub);
        ops.push({
          type: 'overlayStyle', id: opId, overlayId: t.overlayId,
          ...(dzIndex !== 0 && { dzIndex }),
          ...(Math.abs(dOpacity) > 1e-9 && { dOpacity }),
        });
      }
      const batch: BatchEvent = { type: 'BATCH', id: generateBatchId(), timestamp: ts, sessionId: sid, events: subEvents };
      pushEvent(batch);
      pushOp({ type: 'batch', batchId: batch.id, operations: ops });
    }
  }, [pushEvent, pushOp]);

  // ========================================
  // 背景・キャンバスサイズ
  // ========================================

  const addBackgroundEvent = useCallback((event: BackgroundEvent) => {
    const e = { ...event, sessionId: event.sessionId || sessionIdRef.current };
    pushEvent(e);
    pushOp({
      type: 'background', id: e.id,
      ...(e.dColor && { dColor: e.dColor }),
      ...(e.pattern && { pattern: e.pattern }),
      ...(e.dPatternSize !== undefined && { dPatternSize: e.dPatternSize }),
      ...(e.dPatternColor && { dPatternColor: e.dPatternColor }),
    });
  }, [pushEvent, pushOp]);

  const addCanvasSizeEvent = useCallback((event: CanvasSizeEvent) => {
    const e = { ...event, sessionId: event.sessionId || sessionIdRef.current };
    pushEvent(e);
    pushOp({
      type: 'canvasSize' as const, id: e.id,
      ...(e.dCanvasWidth !== undefined && { dCanvasWidth: e.dCanvasWidth }),
      ...(e.dCanvasHeight !== undefined && { dCanvasHeight: e.dCanvasHeight }),
    });
  }, [pushEvent, pushOp]);

  // ========================================
  // 投げ縄操作（BATCH）
  // ========================================

  const lassoMoveSelection = useCallback((
    originalStrokes: DrawEvent[], movedStrokes: DrawEvent[],
    overlayDeltas: Array<{overlayId: string; dx: number; dy: number}>,
  ) => {
    if (!yEventsRef.current) return;
    if (originalStrokes.length === 0 && overlayDeltas.length === 0) return;
    const ts = getTimestamp();
    const sid = sessionIdRef.current;
    const subEvents: SubEvent[] = [];
    const ops: SingleOperation[] = [];

    // 元ストロークを消去
    for (const stroke of originalStrokes) {
      const eid = generateEraseId();
      subEvents.push({ type: 'E', timestamp: ts, sessionId: sid, id: eid, targetId: stroke.id });
      ops.push({ type: 'erase', eraseId: eid, targetId: stroke.id, targetStroke: stroke });
    }

    // 移動後ストロークを追加
    for (const stroke of movedStrokes) {
      const s = { ...stroke, timestamp: ts, sessionId: sid };
      subEvents.push(s);
      ops.push({ type: 'draw', strokeId: s.id, strokeData: s });
    }

    // オーバーレイ移動 (OT)
    for (const { overlayId, dx, dy } of overlayDeltas) {
      const opId = generateTransformOpId();
      const otEvent: OverlayTransformEvent = {
        type: 'OT', timestamp: ts, sessionId: sid, id: opId, overlayId,
        ...(dx !== 0 && { dx }), ...(dy !== 0 && { dy }),
      };
      subEvents.push(otEvent);
      ops.push({ type: 'overlayTransform', id: opId, overlayId, dx, dy, dWidth: 0, dHeight: 0, dRotation: 0 });
    }

    if (subEvents.length === 1) {
      pushEvent(subEvents[0] as WbelxEvent);
      pushOp(ops[0]);
    } else if (subEvents.length >= 2) {
      const batch: BatchEvent = { type: 'BATCH', id: generateBatchId(), timestamp: ts, sessionId: sid, events: subEvents };
      pushEvent(batch);
      pushOp({ type: 'batch', batchId: batch.id, operations: ops });
    }
  }, [pushEvent, pushOp]);

  const lassoDeleteSelection = useCallback((strokes: DrawEvent[], overlayIds: string[]) => {
    if (!yEventsRef.current) return;
    if (strokes.length === 0 && overlayIds.length === 0) return;
    const ts = getTimestamp();
    const sid = sessionIdRef.current;
    const subEvents: SubEvent[] = [];
    const ops: SingleOperation[] = [];

    // ストローク消去
    for (const stroke of strokes) {
      const eid = generateEraseId();
      subEvents.push({ type: 'E', timestamp: ts, sessionId: sid, id: eid, targetId: stroke.id });
      ops.push({ type: 'erase', eraseId: eid, targetId: stroke.id, targetStroke: stroke });
    }

    // オーバーレイ削除
    for (const overlayId of overlayIds) {
      const overlay = stateRef.current.overlays.get(overlayId);
      if (!overlay) continue;
      const targetOverlay: OverlayAddEvent = {
        type: 'OA', timestamp: '', sessionId: '',
        overlayId: overlay.overlayId, assetUuid: overlay.assetUuid,
        x: overlay.x, y: overlay.y, width: overlay.width, height: overlay.height,
        rotation: overlay.rotation, viewport: overlay.viewport,
        page: overlay.page, zIndex: overlay.zIndex, opacity: overlay.opacity,
      };
      const rid = generateRemoveId();
      subEvents.push({ type: 'OR', timestamp: ts, sessionId: sid, removeId: rid, targetOverlayId: overlayId });
      ops.push({ type: 'overlayRemove', removeId: rid, targetOverlayId: overlayId, targetOverlay });
    }

    if (subEvents.length === 1) {
      pushEvent(subEvents[0] as WbelxEvent);
      pushOp(ops[0]);
    } else if (subEvents.length >= 2) {
      const batch: BatchEvent = { type: 'BATCH', id: generateBatchId(), timestamp: ts, sessionId: sid, events: subEvents };
      pushEvent(batch);
      pushOp({ type: 'batch', batchId: batch.id, operations: ops });
    }
  }, [pushEvent, pushOp]);

  /**
   * 投げ縄: 複製/貼り付け共通。ストロークとオーバーレイを新規作成する。
   * dx, dy は元の位置からのオフセット。
   * 戻り値は新しい ID のセット（選択状態更新用）。
   */
  const lassoCreateSelection = useCallback((
    strokes: DrawEvent[], overlays: OverlayState[],
    dx: number, dy: number,
  ): { newStrokeIds: string[]; newOverlayIds: string[] } => {
    if (!yEventsRef.current) return { newStrokeIds: [], newOverlayIds: [] };
    const ts = getTimestamp();
    const sid = sessionIdRef.current;
    const subEvents: SubEvent[] = [];
    const ops: SingleOperation[] = [];
    const newStrokeIds: string[] = [];
    const newOverlayIds: string[] = [];

    // ストローク複製
    for (const stroke of strokes) {
      const newId = generateStrokeId();
      newStrokeIds.push(newId);
      const newStroke: DrawEvent = {
        ...stroke,
        id: newId, timestamp: ts, sessionId: sid,
        path: dx !== 0 || dy !== 0 ? offsetSvgPathSimple(stroke.path, dx, dy) : stroke.path,
        bbox: stroke.bbox ? [
          stroke.bbox[0] + dx, stroke.bbox[1] + dy,
          stroke.bbox[2] + dx, stroke.bbox[3] + dy,
        ] as [number, number, number, number] : stroke.bbox,
      };
      subEvents.push(newStroke);
      ops.push({ type: 'draw', strokeId: newId, strokeData: newStroke });
    }

    // オーバーレイ複製
    // 新しい zIndex を既存の最大値以降に割り当て
    let maxZ = 0;
    for (const [, ov] of stateRef.current.overlays) {
      if (stateRef.current.activeOverlayIds.has(ov.overlayId) && ov.zIndex > maxZ) maxZ = ov.zIndex;
    }
    for (const overlay of overlays) {
      const newOvId = generateOverlayId();
      newOverlayIds.push(newOvId);
      maxZ++;
      const oaEvent: OverlayAddEvent = {
        type: 'OA', timestamp: ts, sessionId: sid,
        overlayId: newOvId, assetUuid: overlay.assetUuid,
        x: overlay.x + dx, y: overlay.y + dy,
        width: overlay.width, height: overlay.height,
        rotation: overlay.rotation, viewport: { ...overlay.viewport },
        page: overlay.page, zIndex: maxZ, opacity: overlay.opacity,
      };
      subEvents.push(oaEvent);
      ops.push({ type: 'overlayAdd', overlayId: newOvId, overlayData: oaEvent });
    }

    if (subEvents.length === 1) {
      pushEvent(subEvents[0] as WbelxEvent);
      pushOp(ops[0]);
    } else if (subEvents.length >= 2) {
      const batch: BatchEvent = { type: 'BATCH', id: generateBatchId(), timestamp: ts, sessionId: sid, events: subEvents };
      pushEvent(batch);
      pushOp({ type: 'batch', batchId: batch.id, operations: ops });
    }

    return { newStrokeIds, newOverlayIds };
  }, [pushEvent, pushOp]);

  const lassoDuplicateSelection = useCallback((
    strokes: DrawEvent[], overlays: OverlayState[],
    dx: number, dy: number,
  ) => {
    return lassoCreateSelection(strokes, overlays, dx, dy);
  }, [lassoCreateSelection]);

  const lassoPasteSelection = useCallback((
    strokes: DrawEvent[], overlays: OverlayState[],
    dx: number, dy: number,
  ) => {
    return lassoCreateSelection(strokes, overlays, dx, dy);
  }, [lassoCreateSelection]);

  // ========================================
  // Undo / Redo
  // ========================================

  const performUndo = useCallback(() => {
    if (undoStack.length === 0 || !yEventsRef.current) return;
    const op = undoStack[undoStack.length - 1];
    const ts = getTimestamp();
    const sid = sessionIdRef.current;

    if (op.type === 'batch') {
      // BATCH Undo: 逆順に反転した BATCH を発行
      const undoSubs = op.operations.slice().reverse().map(sub => createUndoSubEvent(sub, ts, sid));
      const batch: BatchEvent = { type: 'BATCH', id: generateBatchId(), timestamp: ts, sessionId: sid, events: undoSubs };
      pushEvent(batch);
    } else {
      // Single Undo
      const singleOp = op as SingleOperation;
      // draw/overlayAdd の Undo は対象がアクティブであることを確認
      if (singleOp.type === 'draw' && !stateRef.current.activeStrokeIds.has(singleOp.strokeId)) return;
      if (singleOp.type === 'overlayAdd' && !stateRef.current.activeOverlayIds.has(singleOp.overlayId)) return;
      const undoEvent = createUndoSubEvent(singleOp, ts, sid);
      pushEvent(undoEvent as WbelxEvent);
    }

    setUndoStack(prev => prev.slice(0, -1));
    setRedoStack(prev => [...prev, op]);
  }, [undoStack, pushEvent]);

  const performRedo = useCallback(() => {
    if (redoStack.length === 0 || !yEventsRef.current) return;
    const op = redoStack[redoStack.length - 1];
    const ts = getTimestamp();
    const sid = sessionIdRef.current;

    if (op.type === 'batch') {
      // BATCH Redo: 元の順序で再実行
      const redoSubs = op.operations.map(sub => createRedoSubEvent(sub, ts, sid));
      const batch: BatchEvent = { type: 'BATCH', id: generateBatchId(), timestamp: ts, sessionId: sid, events: redoSubs };
      pushEvent(batch);
    } else {
      const redoEvent = createRedoSubEvent(op as SingleOperation, ts, sid);
      pushEvent(redoEvent as WbelxEvent);
    }

    setRedoStack(prev => prev.slice(0, -1));
    setUndoStack(prev => [...prev, op]);
  }, [redoStack, pushEvent]);

  // ========================================
  // カーソル
  // ========================================

  const updateCursor = useCallback((x: number, y: number) => {
    const a = providerRef.current?.awareness;
    if (a) a.setLocalState({ ...a.getLocalState(), cursor: { x, y } });
  }, []);

  const hideCursor = useCallback(() => {
    const a = providerRef.current?.awareness;
    if (a) a.setLocalState({ ...a.getLocalState(), cursor: null });
  }, []);

  // ========================================
  // エクスポート
  // ========================================

  const exportWbelx = useCallback(() => eventsToWbelx(events), [events]);
  const exportSnapshotWbelx = useCallback(() => {
    const snaps: WbelxEvent[] = [];
    for (const id of state.activeStrokeIds) {
      const s = state.strokes.get(id);
      if (s) snaps.push(s);
    }
    for (const id of state.activeOverlayIds) {
      const overlay = state.overlays.get(id);
      if (overlay) {
        snaps.push({
          type: 'OA', timestamp: getTimestamp(), sessionId: sessionIdRef.current,
          overlayId: overlay.overlayId, assetUuid: overlay.assetUuid,
          x: overlay.x, y: overlay.y, width: overlay.width, height: overlay.height,
          rotation: overlay.rotation, viewport: overlay.viewport,
          page: overlay.page, zIndex: overlay.zIndex, opacity: overlay.opacity,
        });
      }
    }
    const h = generateSnapshotHash();
    return createSnapshot(snaps, h, state.background);
  }, [state]);

  // ========================================
  // Memoized 派生データ
  // ========================================

  const activeStrokes = useMemo(() => getActiveStrokes(state), [state]);
  const activeOverlays = useMemo(() => getActiveOverlays(state), [state]);

  return {
    isConnected, signalingConnected, peerCount, isHost, isHostConnected,
    guestsPresent, isJoiningRoom, peerSearchTimedOut, hasSyncedData,
    events, state, activeStrokes, activeOverlays, cursors,
    addDrawEvent, eraseStrokes, addOverlayEvent, removeOverlay,
    transformOverlayEvent, viewportOverlayEvent, styleOverlays,
    addBackgroundEvent, addCanvasSizeEvent,
    lassoMoveSelection, lassoDeleteSelection,
    lassoDuplicateSelection, lassoPasteSelection,
    performUndo, performRedo,
    canUndo: undoStackReady && undoStack.length > 0,
    canRedo: undoStackReady && redoStack.length > 0,
    undoStackReady,
    updateCursor, hideCursor,
    sessionId: sessionIdRef.current,
    userId: userIdRef.current,
    userColor: userColorRef.current,
    exportWbelx, exportSnapshotWbelx,
    hasContent: events.length > 0,
    provider: activeProvider,
  };
}
