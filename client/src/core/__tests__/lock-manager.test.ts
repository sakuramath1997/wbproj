/**
 * core/__tests__/lock-manager.test.ts
 *
 * Object Lock Protocol コアロジックのユニットテスト。
 * application-spec v3 §Object Lock Protocol に準拠。
 */

import { describe, test, expect } from 'vitest';
import {
  createLockState,
  canLock,
  applyLock,
  applyUnlock,
  releaseAllBySession,
  isLockedByOther,
  getLockedByOthers,
  processLockRequest,
} from '../lock-manager';
import type { LockRequestMessage } from '../lock-manager';

describe('lock-manager', () => {
  // ========================================
  // createLockState
  // ========================================
  describe('createLockState', () => {
    test('空の LockState を生成する', () => {
      const state = createLockState();
      expect(state.locks.size).toBe(0);
    });
  });

  // ========================================
  // canLock
  // ========================================
  describe('canLock', () => {
    test('空状態では全て granted', () => {
      const state = createLockState();
      const result = canLock(state, ['s:001', 's:002', 'o:003'], 'sess-a');
      expect(result.granted).toEqual(['s:001', 's:002', 'o:003']);
      expect(result.denied).toEqual([]);
    });

    test('自分が保持中の ID は再 granted', () => {
      let state = createLockState();
      state = applyLock(state, 'sess-a', ['s:001']);
      const result = canLock(state, ['s:001', 's:002'], 'sess-a');
      expect(result.granted).toEqual(['s:001', 's:002']);
      expect(result.denied).toEqual([]);
    });

    test('他セッションが保持中の ID は denied', () => {
      let state = createLockState();
      state = applyLock(state, 'sess-b', ['s:002']);
      const result = canLock(state, ['s:001', 's:002', 'o:003'], 'sess-a');
      expect(result.granted).toEqual(['s:001', 'o:003']);
      expect(result.denied).toEqual([{ id: 's:002', heldBy: 'sess-b' }]);
    });

    test('部分選択: 仕様例のケース', () => {
      // application-spec v3 §Object Lock Protocol の例
      let state = createLockState();
      state = applyLock(state, 'sess-b', ['s:002']);
      const result = canLock(state, ['s:001', 's:002', 'o:003', 's:004'], 'sess-a');
      expect(result.granted).toEqual(['s:001', 'o:003', 's:004']);
      expect(result.denied).toEqual([{ id: 's:002', heldBy: 'sess-b' }]);
    });

    test('全て denied のケース', () => {
      let state = createLockState();
      state = applyLock(state, 'sess-b', ['s:001', 's:002']);
      const result = canLock(state, ['s:001', 's:002'], 'sess-a');
      expect(result.granted).toEqual([]);
      expect(result.denied).toHaveLength(2);
    });
  });

  // ========================================
  // applyLock / applyUnlock
  // ========================================
  describe('applyLock', () => {
    test('ロックを適用する', () => {
      const state = createLockState();
      const newState = applyLock(state, 'sess-a', ['s:001', 'o:002']);
      expect(newState.locks.get('s:001')).toBe('sess-a');
      expect(newState.locks.get('o:002')).toBe('sess-a');
      // 元の state は変更されない
      expect(state.locks.size).toBe(0);
    });

    test('空配列では状態が変わらない', () => {
      const state = createLockState();
      const newState = applyLock(state, 'sess-a', []);
      expect(newState).toBe(state);
    });
  });

  describe('applyUnlock', () => {
    test('自分のロックを解放する', () => {
      let state = createLockState();
      state = applyLock(state, 'sess-a', ['s:001', 'o:002']);
      const newState = applyUnlock(state, 'sess-a', ['s:001']);
      expect(newState.locks.has('s:001')).toBe(false);
      expect(newState.locks.get('o:002')).toBe('sess-a');
    });

    test('他セッションのロックは解放しない', () => {
      let state = createLockState();
      state = applyLock(state, 'sess-b', ['s:001']);
      const newState = applyUnlock(state, 'sess-a', ['s:001']);
      expect(newState.locks.get('s:001')).toBe('sess-b');
    });
  });

  // ========================================
  // releaseAllBySession
  // ========================================
  describe('releaseAllBySession', () => {
    test('指定セッションの全ロックを解放する', () => {
      let state = createLockState();
      state = applyLock(state, 'sess-a', ['s:001', 's:002']);
      state = applyLock(state, 'sess-b', ['o:003']);
      const newState = releaseAllBySession(state, 'sess-a');
      expect(newState.locks.has('s:001')).toBe(false);
      expect(newState.locks.has('s:002')).toBe(false);
      expect(newState.locks.get('o:003')).toBe('sess-b');
    });

    test('該当セッションがなければ同じオブジェクトを返す', () => {
      let state = createLockState();
      state = applyLock(state, 'sess-b', ['o:003']);
      const newState = releaseAllBySession(state, 'sess-a');
      expect(newState).toBe(state);
    });
  });

  // ========================================
  // isLockedByOther / getLockedByOthers
  // ========================================
  describe('isLockedByOther', () => {
    test('他セッションがロック中なら true', () => {
      let state = createLockState();
      state = applyLock(state, 'sess-b', ['s:001']);
      expect(isLockedByOther(state, 's:001', 'sess-a')).toBe(true);
    });

    test('自セッションのロックは false', () => {
      let state = createLockState();
      state = applyLock(state, 'sess-a', ['s:001']);
      expect(isLockedByOther(state, 's:001', 'sess-a')).toBe(false);
    });

    test('ロックなしは false', () => {
      const state = createLockState();
      expect(isLockedByOther(state, 's:001', 'sess-a')).toBe(false);
    });
  });

  describe('getLockedByOthers', () => {
    test('他セッションにロックされた ID のみ返す', () => {
      let state = createLockState();
      state = applyLock(state, 'sess-a', ['s:001']);
      state = applyLock(state, 'sess-b', ['s:002', 'o:003']);
      const locked = getLockedByOthers(state, ['s:001', 's:002', 'o:003', 's:004'], 'sess-a');
      expect(locked).toEqual(['s:002', 'o:003']);
    });
  });

  // ========================================
  // processLockRequest
  // ========================================
  describe('processLockRequest', () => {
    test('全 granted のケース', () => {
      const state = createLockState();
      const request: LockRequestMessage = {
        type: 'lock_request',
        sessionId: 'sess-a',
        targetIds: ['s:001', 'o:002'],
      };
      const { newState, grantedMsg, deniedMsg } = processLockRequest(state, request);
      expect(grantedMsg).toEqual({
        type: 'lock_granted',
        sessionId: 'sess-a',
        grantedIds: ['s:001', 'o:002'],
      });
      expect(deniedMsg).toBeNull();
      expect(newState.locks.get('s:001')).toBe('sess-a');
      expect(newState.locks.get('o:002')).toBe('sess-a');
    });

    test('部分 granted + 部分 denied のケース', () => {
      let state = createLockState();
      state = applyLock(state, 'sess-b', ['s:002']);
      const request: LockRequestMessage = {
        type: 'lock_request',
        sessionId: 'sess-a',
        targetIds: ['s:001', 's:002', 'o:003', 's:004'],
      };
      const { newState, grantedMsg, deniedMsg } = processLockRequest(state, request);
      expect(grantedMsg).toEqual({
        type: 'lock_granted',
        sessionId: 'sess-a',
        grantedIds: ['s:001', 'o:003', 's:004'],
      });
      expect(deniedMsg).toEqual({
        type: 'lock_denied',
        sessionId: 'sess-a',
        deniedIds: ['s:002'],
        heldBy: { 's:002': 'sess-b' },
      });
      expect(newState.locks.get('s:001')).toBe('sess-a');
      expect(newState.locks.get('s:002')).toBe('sess-b'); // 変更なし
      expect(newState.locks.get('o:003')).toBe('sess-a');
    });

    test('全 denied のケース', () => {
      let state = createLockState();
      state = applyLock(state, 'sess-b', ['s:001']);
      const request: LockRequestMessage = {
        type: 'lock_request',
        sessionId: 'sess-a',
        targetIds: ['s:001'],
      };
      const { newState, grantedMsg, deniedMsg } = processLockRequest(state, request);
      expect(grantedMsg).toBeNull();
      expect(deniedMsg).not.toBeNull();
      expect(deniedMsg!.deniedIds).toEqual(['s:001']);
      // 状態変更なし
      expect(newState).toBe(state);
    });
  });
});
