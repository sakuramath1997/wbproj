/**
 * core/lock-manager.ts — Object Lock Protocol コアロジック（Rust 移植対象）
 *
 * React 非依存。ブラウザ API 非依存。
 *
 * 参照仕様:
 *   application-spec v3 §Object Lock Protocol:
 *     ロック状態はメモリ上のみに存在し、P2P の DataChannel メッセージで同期する。
 *     wbelx にはロック/アンロックイベントを記録しない。
 *
 * パターン: 状態オブジェクト + 純粋操作関数（§4.2 準拠）
 */

// ========================================
// 型定義
// ========================================

/** ボード単位のロック状態（メモリ上のみ） */
export interface LockState {
  /** objectId → sessionId（ロック保持者） */
  readonly locks: ReadonlyMap<string, string>;
}

/** ロック要求の判定結果 */
export interface LockResult {
  /** ロック取得に成功した ID */
  granted: string[];
  /** ロック取得に失敗した ID と保持者 */
  denied: Array<{ id: string; heldBy: string }>;
}

// ========================================
// DataChannel メッセージ型
// ========================================

export interface LockRequestMessage {
  type: 'lock_request';
  sessionId: string;
  targetIds: string[];
}

export interface LockGrantedMessage {
  type: 'lock_granted';
  sessionId: string;
  grantedIds: string[];
}

export interface LockDeniedMessage {
  type: 'lock_denied';
  sessionId: string;
  deniedIds: string[];
  /** objectId → sessionId（保持者） */
  heldBy: Record<string, string>;
}

export interface UnlockMessage {
  type: 'unlock';
  sessionId: string;
  targetIds: string[];
}

export type LockMessage =
  | LockRequestMessage
  | LockGrantedMessage
  | LockDeniedMessage
  | UnlockMessage;

// ========================================
// 状態生成
// ========================================

export function createLockState(): LockState {
  return { locks: new Map() };
}

// ========================================
// 純粋操作関数
// ========================================

/**
 * ロック要求の判定（純粋関数）。
 *
 * 仕様: 競合解決ポリシー: 部分選択
 *   一部が他セッションにロックされている場合は、取得できたもののみ granted。
 */
export function canLock(
  state: LockState,
  targetIds: ReadonlyArray<string>,
  requestingSession: string,
): LockResult {
  const granted: string[] = [];
  const denied: Array<{ id: string; heldBy: string }> = [];

  for (const id of targetIds) {
    const holder = state.locks.get(id);
    if (holder === undefined || holder === requestingSession) {
      granted.push(id);
    } else {
      denied.push({ id, heldBy: holder });
    }
  }

  return { granted, denied };
}

/**
 * ロックを適用する。granted な ID を sessionId でロックする。
 * 新しい LockState を返す（immutable パターン）。
 */
export function applyLock(
  state: LockState,
  sessionId: string,
  ids: ReadonlyArray<string>,
): LockState {
  if (ids.length === 0) return state;
  const newLocks = new Map(state.locks);
  for (const id of ids) {
    newLocks.set(id, sessionId);
  }
  return { locks: newLocks };
}

/**
 * ロックを解放する。指定 ID のロックを解放する（保持者チェック付き）。
 */
export function applyUnlock(
  state: LockState,
  sessionId: string,
  ids: ReadonlyArray<string>,
): LockState {
  if (ids.length === 0) return state;
  const newLocks = new Map(state.locks);
  for (const id of ids) {
    const holder = newLocks.get(id);
    // 自分が保持者の場合のみ解放
    if (holder === sessionId) {
      newLocks.delete(id);
    }
  }
  return { locks: newLocks };
}

/**
 * 指定セッションの全ロックを解放する（ピア切断時に使用）。
 */
export function releaseAllBySession(
  state: LockState,
  sessionId: string,
): LockState {
  const newLocks = new Map<string, string>();
  for (const [id, holder] of state.locks) {
    if (holder !== sessionId) {
      newLocks.set(id, holder);
    }
  }
  // 変更がなければ同じオブジェクトを返す
  if (newLocks.size === state.locks.size) return state;
  return { locks: newLocks };
}

/**
 * 指定オブジェクトがロック中か判定する。
 */
export function isLockedByOther(
  state: LockState,
  objectId: string,
  mySessionId: string,
): boolean {
  const holder = state.locks.get(objectId);
  return holder !== undefined && holder !== mySessionId;
}

/**
 * 指定オブジェクト群のうち、他セッションにロックされている ID を返す。
 */
export function getLockedByOthers(
  state: LockState,
  objectIds: ReadonlyArray<string>,
  mySessionId: string,
): string[] {
  return objectIds.filter(id => isLockedByOther(state, id, mySessionId));
}

/**
 * lock_request を受信した側（ホストまたはピア）がロック判定 + 適用を行い、
 * 応答メッセージを生成する。
 */
export function processLockRequest(
  state: LockState,
  request: LockRequestMessage,
): {
  newState: LockState;
  grantedMsg: LockGrantedMessage | null;
  deniedMsg: LockDeniedMessage | null;
} {
  const result = canLock(state, request.targetIds, request.sessionId);

  // granted があればロック適用
  const newState = result.granted.length > 0
    ? applyLock(state, request.sessionId, result.granted)
    : state;

  const grantedMsg: LockGrantedMessage | null = result.granted.length > 0
    ? { type: 'lock_granted', sessionId: request.sessionId, grantedIds: result.granted }
    : null;

  const deniedMsg: LockDeniedMessage | null = result.denied.length > 0
    ? {
        type: 'lock_denied',
        sessionId: request.sessionId,
        deniedIds: result.denied.map(d => d.id),
        heldBy: Object.fromEntries(result.denied.map(d => [d.id, d.heldBy])),
      }
    : null;

  return { newState, grantedMsg, deniedMsg };
}
