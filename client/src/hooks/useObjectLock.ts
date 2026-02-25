/**
 * hooks/useObjectLock.ts — Object Lock Protocol Shell フック (L3)
 *
 * application-spec v3 §Object Lock Protocol の実装。
 *
 * Yjs Awareness を利用してロック状態を P2P 同期する。
 * 各ピアが自身のロック対象を awareness に公開し、
 * 他ピアの awareness からグローバルなロック状態を導出する。
 *
 * Core 層: core/lock-manager.ts（ロック判定・状態管理）
 *
 * 仕様準拠ポイント:
 *   - ロック状態はメモリ上のみ（wbelx に記録しない）
 *   - ピア切断時は awareness 自動クリーンアップでロック全解放
 *   - ボード再読込時はリセット
 *   - 部分選択: 一部がロック中なら取得可能分のみ granted
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import type { WebrtcProvider } from 'y-webrtc';
import {
  type LockState,
  createLockState,
  canLock,
  applyLock,
  isLockedByOther,
  getLockedByOthers,
} from '../core/lock-manager';

// ========================================
// 型定義
// ========================================

export interface UseObjectLockOptions {
  /** セッション ID */
  sessionId: string;
  /** WebRTC Provider（awareness 経由でロック同期） */
  provider: WebrtcProvider | null;
}

export interface LockAcquireResult {
  /** ロック取得に成功した ID */
  granted: string[];
  /** ロック取得に失敗した ID と保持者セッション */
  denied: Array<{ id: string; heldBy: string }>;
}

export interface UseObjectLockReturn {
  /**
   * ロック取得を試行する。部分選択ポリシー:
   * 他セッションにロックされていない ID のみ granted。
   */
  acquireLock: (targetIds: string[]) => LockAcquireResult;
  /** ロックを解放する */
  releaseLock: (targetIds: string[]) => void;
  /** 自セッションの全ロックを解放する */
  releaseAll: () => void;
  /** 指定オブジェクトが他セッションにロック中か */
  isLocked: (objectId: string) => boolean;
  /** 指定オブジェクト群のうち他セッションにロック中の ID */
  getLockedIds: (objectIds: string[]) => string[];
  /** 現在のロック状態（全ピア統合） */
  lockState: LockState;
}

// ========================================
// フック本体
// ========================================

export function useObjectLock({
  sessionId,
  provider,
}: UseObjectLockOptions): UseObjectLockReturn {
  // ---- 自セッションのロック対象 ----
  const [, setMyLocks] = useState<string[]>([]);

  // ---- 全ピア統合のロック状態 ----
  const [lockState, setLockState] = useState<LockState>(createLockState);
  const myLocksRef = useRef<string[]>([]);

  // ---- awareness からロック状態を再構築 ----
  const rebuildLockState = useCallback(() => {
    if (!provider) {
      setLockState(createLockState());
      return;
    }

    const awareness = provider.awareness;
    const states = awareness.getStates();
    let state = createLockState();

    states.forEach((st: { lockedObjects?: string[]; user?: { id: string } }, _clientId: number) => {
      if (!st.lockedObjects || st.lockedObjects.length === 0) return;

      // awareness state に sessionId を格納している場合はそれを使用
      const peerSessionId = (st as { sessionId?: string }).sessionId;
      if (!peerSessionId) return;

      state = applyLock(state, peerSessionId, st.lockedObjects);
    });

    setLockState(state);
  }, [provider]);

  // ---- awareness の lockedObjects を更新 ----
  const updateAwareness = useCallback((locks: string[]) => {
    if (!provider) return;
    const awareness = provider.awareness;
    const current = awareness.getLocalState() || {};
    awareness.setLocalState({
      ...current,
      sessionId,
      lockedObjects: locks,
    });
  }, [provider, sessionId]);

  // ---- provider 変更時の初期ロック状態構築（React recommended: during render）----
  const [prevProvider, setPrevProvider] = useState(provider);
  if (provider !== prevProvider) {
    setPrevProvider(provider);
    if (provider) {
      const awareness = provider.awareness;
      const states = awareness.getStates();
      let state = createLockState();
      states.forEach((st: { lockedObjects?: string[]; user?: { id: string } }, _clientId: number) => {
        if (!st.lockedObjects || st.lockedObjects.length === 0) return;
        const peerSessionId = (st as { sessionId?: string }).sessionId;
        if (!peerSessionId) return;
        state = applyLock(state, peerSessionId, st.lockedObjects);
      });
      setLockState(state);
    } else {
      setLockState(createLockState());
    }
  }

  // ---- awareness 変更の監視 ----
  useEffect(() => {
    if (!provider) return;
    const awareness = provider.awareness;

    // 初期状態を設定
    const current = awareness.getLocalState() || {};
    awareness.setLocalState({
      ...current,
      sessionId,
      lockedObjects: myLocksRef.current,
    });

    const handleChange = () => rebuildLockState();
    awareness.on('change', handleChange);

    return () => {
      awareness.off('change', handleChange);
      // 切断時に自セッションのロックをクリア
      const currentState = awareness.getLocalState() || {};
      awareness.setLocalState({
        ...currentState,
        lockedObjects: [],
      });
    };
  }, [provider, sessionId, rebuildLockState]);

  // ========================================
  // 公開 API
  // ========================================

  /** ロック取得を試行する */
  const acquireLock = useCallback((targetIds: string[]): LockAcquireResult => {
    if (targetIds.length === 0) return { granted: [], denied: [] };

    // 現在の統合ロック状態からロック判定
    const result = canLock(lockState, targetIds, sessionId);

    if (result.granted.length > 0) {
      // 自セッションのロック対象を更新
      const newLocks = [...new Set([...myLocksRef.current, ...result.granted])];
      myLocksRef.current = newLocks;
      setMyLocks(newLocks);
      updateAwareness(newLocks);
    }

    return result;
  }, [lockState, sessionId, updateAwareness]);

  /** ロックを解放する */
  const releaseLock = useCallback((targetIds: string[]) => {
    if (targetIds.length === 0) return;
    const targetSet = new Set(targetIds);
    const newLocks = myLocksRef.current.filter(id => !targetSet.has(id));
    myLocksRef.current = newLocks;
    setMyLocks(newLocks);
    updateAwareness(newLocks);
  }, [updateAwareness]);

  /** 自セッションの全ロックを解放する */
  const releaseAll = useCallback(() => {
    myLocksRef.current = [];
    setMyLocks([]);
    updateAwareness([]);
  }, [updateAwareness]);

  /** 指定オブジェクトが他セッションにロック中か */
  const isLocked = useCallback((objectId: string): boolean => {
    return isLockedByOther(lockState, objectId, sessionId);
  }, [lockState, sessionId]);

  /** 指定オブジェクト群のうち他セッションにロック中の ID */
  const getLockedIds = useCallback((objectIds: string[]): string[] => {
    return getLockedByOthers(lockState, objectIds, sessionId);
  }, [lockState, sessionId]);

  return {
    acquireLock,
    releaseLock,
    releaseAll,
    isLocked,
    getLockedIds,
    lockState,
  };
}
