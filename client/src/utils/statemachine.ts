/**
 * wbelx ステートマシン v2
 *
 * OT/OV は差分適用、OS は複数ターゲット対応。
 * zIndex 一意性制約: OS 適用は zIndex 降順で行い中間状態の衝突を防ぐ。
 */

import type {
  DrawEvent,
  WbelxEvent,
  WbelxState,
  OverlayState,
  OverlayAddEvent,
} from '../types';

// ========================================
// 初期状態
// ========================================

export function createInitialState(): WbelxState {
  return {
    activeStrokeIds: new Set(),
    strokes: new Map(),
    activeOverlayIds: new Set(),
    overlays: new Map(),
  };
}

// ========================================
// イベント適用
// ========================================

export function applyEvent(state: WbelxState, event: WbelxEvent): WbelxState {
  switch (event.type) {
    case 'D': {
      const newStrokes = new Map(state.strokes);
      newStrokes.set(event.id, event);
      const newActiveIds = new Set(state.activeStrokeIds);
      newActiveIds.add(event.id);
      return { ...state, activeStrokeIds: newActiveIds, strokes: newStrokes };
    }

    case 'E': {
      const newActiveIds = new Set(state.activeStrokeIds);
      for (const id of event.targetIds) newActiveIds.delete(id);
      return { ...state, activeStrokeIds: newActiveIds };
    }

    case 'S':
      return state;

    case 'OA': {
      const overlayState: OverlayState = {
        overlayId: event.overlayId,
        assetUuid: event.assetUuid,
        x: event.x,
        y: event.y,
        width: event.width,
        height: event.height,
        rotation: event.rotation,
        viewport: event.viewport,
        page: event.page,
        zIndex: event.zIndex,
        opacity: event.opacity,
      };
      const newOverlays = new Map(state.overlays);
      newOverlays.set(event.overlayId, overlayState);
      const newActiveOverlayIds = new Set(state.activeOverlayIds);
      newActiveOverlayIds.add(event.overlayId);
      return { ...state, activeOverlayIds: newActiveOverlayIds, overlays: newOverlays };
    }

    case 'OR': {
      const newActiveOverlayIds = new Set(state.activeOverlayIds);
      for (const id of event.targetOverlayIds) newActiveOverlayIds.delete(id);
      return { ...state, activeOverlayIds: newActiveOverlayIds };
    }

    case 'OT': {
      // 差分適用: 存在するフィールドのみ上書き
      const existing = state.overlays.get(event.overlayId);
      if (!existing) return state;
      const updated: OverlayState = {
        ...existing,
        ...(event.x       !== undefined && { x:        event.x }),
        ...(event.y       !== undefined && { y:        event.y }),
        ...(event.width   !== undefined && { width:    event.width }),
        ...(event.height  !== undefined && { height:   event.height }),
        ...(event.rotation !== undefined && { rotation: event.rotation }),
      };
      const newOverlays = new Map(state.overlays);
      newOverlays.set(event.overlayId, updated);
      return { ...state, overlays: newOverlays };
    }

    case 'OV': {
      // 差分適用
      const existing = state.overlays.get(event.overlayId);
      if (!existing) return state;
      const updated: OverlayState = {
        ...existing,
        ...(event.viewport !== undefined && { viewport: event.viewport }),
        ...(event.page     !== undefined && { page:     event.page }),
      };
      const newOverlays = new Map(state.overlays);
      newOverlays.set(event.overlayId, updated);
      return { ...state, overlays: newOverlays };
    }

    case 'OS': {
      // zIndex 降順でソートして適用（中間状態の一意性維持）
      const sorted = [...event.targets].sort((a, b) => {
        const za = a.zIndex ?? -Infinity;
        const zb = b.zIndex ?? -Infinity;
        return zb - za;
      });
      const newOverlays = new Map(state.overlays);
      for (const target of sorted) {
        const existing = newOverlays.get(target.overlayId);
        if (!existing) continue;
        newOverlays.set(target.overlayId, {
          ...existing,
          ...(target.zIndex  !== undefined && { zIndex:  target.zIndex }),
          ...(target.opacity !== undefined && { opacity: target.opacity }),
        });
      }
      return { ...state, overlays: newOverlays };
    }

    default:
      return state;
  }
}

export function computeState(events: WbelxEvent[]): WbelxState {
  let state = createInitialState();
  for (const event of events) {
    state = applyEvent(state, event);
  }
  // zIndex 正規化フォールバック: 重複があれば overlayId 辞書順で 1, 2, 3, ... に再割当て
  state = normalizeZIndexIfNeeded(state);
  return state;
}

/**
 * activeOverlays の zIndex に重複がある場合、overlayId 辞書順昇順で連番を振り直す。
 * 仕様 §5-3 に準拠。
 */
function normalizeZIndexIfNeeded(state: WbelxState): WbelxState {
  const activeIds = Array.from(state.activeOverlayIds);
  if (activeIds.length <= 1) return state;

  // 重複検出
  const zValues = new Set<number>();
  let hasDuplicate = false;
  for (const id of activeIds) {
    const overlay = state.overlays.get(id);
    if (!overlay) continue;
    if (zValues.has(overlay.zIndex)) {
      hasDuplicate = true;
      break;
    }
    zValues.add(overlay.zIndex);
  }
  if (!hasDuplicate) return state;

  // overlayId 辞書順昇順でソートし、1, 2, 3, ... を割り当て
  const sorted = [...activeIds].sort();
  const newOverlays = new Map(state.overlays);
  sorted.forEach((id, i) => {
    const existing = newOverlays.get(id);
    if (existing) {
      newOverlays.set(id, { ...existing, zIndex: i + 1 });
    }
  });
  return { ...state, overlays: newOverlays };
}

// ========================================
// アクティブな要素を取得
// ========================================

export function getActiveStrokes(state: WbelxState): DrawEvent[] {
  const result: DrawEvent[] = [];
  for (const id of state.activeStrokeIds) {
    const stroke = state.strokes.get(id);
    if (stroke) result.push(stroke);
  }
  return result;
}

/** アクティブなオーバーレイを zIndex 昇順で返す */
export function getActiveOverlays(state: WbelxState): OverlayState[] {
  const result: OverlayState[] = [];
  for (const id of state.activeOverlayIds) {
    const overlay = state.overlays.get(id);
    if (overlay) result.push(overlay);
  }
  result.sort((a, b) => a.zIndex - b.zIndex);
  return result;
}

// ========================================
// OA イベントへの変換（スナップショット用）
// ========================================

export function overlayStateToOAEvent(
  overlay: OverlayState,
  timestamp: string,
  sessionId: string
): OverlayAddEvent {
  return {
    type: 'OA',
    timestamp,
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
  };
}
