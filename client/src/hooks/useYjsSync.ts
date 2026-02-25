/**
 * useYjsSync — P2P コラボレーション同期フック (v5)
 *
 * Phase 3c: useYjs からリネーム・責務縮小。
 *
 * 責務:
 *   - Yjs ドキュメント + Y.Array<WbelxEvent> の管理
 *   - WebRTC Provider の接続・切断
 *   - Awareness（カーソル同期）
 *   - イベント列の同期状態の提供 (events, state, activeStrokes, activeOverlays)
 *   - 統一的イベント追加 API (appendEvent / appendEvents)
 *   - wbelx / スナップショットのエクスポート
 *
 * v5 変更点:
 *   - 個別イベント追加メソッド (addDrawEvent, eraseStrokes 等) を廃止
 *   - appendEvent / appendEvents に統一
 *   - Lasso 操作を useLassoOps に完全移譲
 *   - pushOp (Undo 操作登録) の責務を呼び出し元に移譲
 *   - stateRef を公開（外部フックからのステート参照用）
 *   - exportSnapshotWbelx を core/snapshot-builder 準拠に更新
 */

import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import * as Y from 'yjs';
import { WebrtcProvider } from 'y-webrtc';
import type {
  WbelxEvent,
  CursorInfo,
  WbelxState,
  DrawEvent,
  OverlayState,
} from '../types';
import { computeState, applyEvent, getActiveStrokes, getActiveOverlays } from '../core/state-machine';
import {
  getTimestamp, getOrCreateSessionId, generateSnapshotHash,
  generateBgOpId, generateCsOpId,
} from '../utils/common';
import { eventsToWbelx } from '../utils/wbelx-parser';
import { buildSnapshotContent, flattenSnapshotContent } from '../core/snapshot-builder';

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
// フック型定義
// ========================================

export interface UseYjsSyncOptions {
  roomId: string;
  enabled?: boolean;
  isHost?: boolean;
  initialEvents?: WbelxEvent[];
  projectUuid?: string;
  onPeerJoin?: (name: string) => void;
  onPeerLeave?: (name: string) => void;
  /** 初期イベント読み込み完了時のコールバック（useUndoRedo.startUndoStackBuild） */
  onEventsLoaded?: (events: WbelxEvent[]) => void;
}

export interface UseYjsSyncReturn {
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
  /** 単一イベントを Yjs に追加 */
  appendEvent: (event: WbelxEvent) => void;
  /** 複数イベントを Yjs に一括追加 */
  appendEvents: (events: WbelxEvent[]) => void;
  /** カーソル位置更新 */
  updateCursor: (x: number, y: number) => void;
  /** カーソル非表示 */
  hideCursor: () => void;
  /** セッション ID */
  sessionId: string;
  userId: string;
  userColor: string;
  /** wbelx 全イベントエクスポート */
  exportWbelx: () => string;
  /** スナップショット wbelx エクスポート（wbelx-spec v4 §7 準拠: D + OA + BG + CS） */
  exportSnapshotWbelx: () => string;
  hasContent: boolean;
  provider: WebrtcProvider | null;
  /** 現在のステートマシン状態への参照（外部フック用） */
  stateRef: React.RefObject<WbelxState>;
}

// ========================================
// メインフック
// ========================================

export function useYjsSync({
  roomId,
  enabled = true,
  isHost = false,
  initialEvents = [],
  projectUuid,
  onPeerJoin,
  onPeerLeave,
  onEventsLoaded,
}: UseYjsSyncOptions): UseYjsSyncReturn {
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
  const p2pActiveRef = useRef(false);
  const lastKnownLengthRef = useRef(0);
  const knownPeersRef = useRef<Map<number, string>>(new Map());
  const onPeerJoinRef = useRef(onPeerJoin);
  const onPeerLeaveRef = useRef(onPeerLeave);
  const initialEventsRef = useRef(initialEvents);
  const onEventsLoadedRef = useRef(onEventsLoaded);

  useEffect(() => { onPeerJoinRef.current = onPeerJoin; onPeerLeaveRef.current = onPeerLeave; }, [onPeerJoin, onPeerLeave]);
  useEffect(() => { initialEventsRef.current = initialEvents; }, [initialEvents]);
  useEffect(() => { onEventsLoadedRef.current = onEventsLoaded; }, [onEventsLoaded]);

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

  // ---- 初期イベントロード ----
  const loadInitialEvents = useCallback((yEvents: Y.Array<WbelxEvent>, ydoc: Y.Doc) => {
    if (initialLoadedRef.current) return;
    const current = yEvents.toArray();
    if (current.length > 0) {
      initialLoadedRef.current = true;
      onEventsLoadedRef.current?.(current);
      return;
    }
    if (initialEventsRef.current.length > 0) {
      ydoc.transact(() => {
        for (const e of initialEventsRef.current) yEvents.push([e]);
      });
      onEventsLoadedRef.current?.(initialEventsRef.current);
    }
    initialLoadedRef.current = true;
  }, []);

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
      ydoc.destroy();
      ydocRef.current = null;
      yEventsRef.current = null;
    };
  // NOTE: マウント時のみ実行（Y.Doc のライフサイクル管理）。
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
  // 統一イベント追加 API
  // ========================================

  const appendEvent = useCallback((event: WbelxEvent) => {
    yEventsRef.current?.push([event]);
  }, []);

  const appendEvents = useCallback((evts: WbelxEvent[]) => {
    if (!yEventsRef.current || evts.length === 0) return;
    for (const e of evts) {
      yEventsRef.current.push([e]);
    }
  }, []);

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

  /**
   * スナップショット wbelx エクスポート（wbelx-spec v4 §7 準拠）。
   * core/snapshot-builder を使用し、D + OA + BG 累積行 + CS 累積行を含む。
   */
  const exportSnapshotWbelx = useCallback(() => {
    const ts = getTimestamp();
    const sid = sessionIdRef.current;
    const content = buildSnapshotContent(state, ts, sid, generateBgOpId, generateCsOpId);
    const snapshotEvents = flattenSnapshotContent(content);

    // SS ヘッダー + イベント行を JSONL で出力
    const hash = generateSnapshotHash();
    const header = JSON.stringify({ type: 'SS', version: 4, hash, createdAt: new Date().toISOString() });
    const lines = [header];
    for (const e of snapshotEvents) {
      lines.push(JSON.stringify(e));
    }
    return lines.join('\n');
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
    appendEvent, appendEvents,
    updateCursor, hideCursor,
    sessionId: sessionIdRef.current,
    userId: userIdRef.current,
    userColor: userColorRef.current,
    exportWbelx, exportSnapshotWbelx,
    hasContent: events.length > 0,
    provider: activeProvider,
    stateRef,
  };
}
