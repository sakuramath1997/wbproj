/**
 * wbelx ステートマシン
 * 
 * イベントログから現在の状態（ストローク＋オーバーレイ）を計算
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

/**
 * イベントを適用して状態を更新
 */
export function applyEvent(state: WbelxState, event: WbelxEvent): WbelxState {
  switch (event.type) {
    // ストロークイベント
    case 'D': {
      const newStrokes = new Map(state.strokes);
      newStrokes.set(event.id, event);

      const newActiveIds = new Set(state.activeStrokeIds);
      newActiveIds.add(event.id);

      return {
        ...state,
        activeStrokeIds: newActiveIds,
        strokes: newStrokes,
      };
    }

    case 'E': {
      const newActiveIds = new Set(state.activeStrokeIds);
      for (const targetId of event.targetIds) {
        newActiveIds.delete(targetId);
      }

      return {
        ...state,
        activeStrokeIds: newActiveIds,
      };
    }

    // スナップショット（状態に影響しない）
    case 'S':
      return state;

    // オーバーレイイベント
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

      return {
        ...state,
        activeOverlayIds: newActiveOverlayIds,
        overlays: newOverlays,
      };
    }

    case 'OR': {
      const newActiveOverlayIds = new Set(state.activeOverlayIds);
      for (const targetId of event.targetOverlayIds) {
        newActiveOverlayIds.delete(targetId);
      }

      return {
        ...state,
        activeOverlayIds: newActiveOverlayIds,
      };
    }

    case 'OT': {
      const existing = state.overlays.get(event.overlayId);
      if (!existing) return state;

      const updated: OverlayState = {
        ...existing,
        x: event.x,
        y: event.y,
        width: event.width,
        height: event.height,
        rotation: event.rotation,
      };

      const newOverlays = new Map(state.overlays);
      newOverlays.set(event.overlayId, updated);

      return {
        ...state,
        overlays: newOverlays,
      };
    }

    case 'OV': {
      const existing = state.overlays.get(event.overlayId);
      if (!existing) return state;

      const updated: OverlayState = {
        ...existing,
        viewport: event.viewport,
        page: event.page,
      };

      const newOverlays = new Map(state.overlays);
      newOverlays.set(event.overlayId, updated);

      return {
        ...state,
        overlays: newOverlays,
      };
    }

    case 'OS': {
      const existing = state.overlays.get(event.overlayId);
      if (!existing) return state;

      const updated: OverlayState = {
        ...existing,
        zIndex: event.zIndex,
        opacity: event.opacity,
      };

      const newOverlays = new Map(state.overlays);
      newOverlays.set(event.overlayId, updated);

      return {
        ...state,
        overlays: newOverlays,
      };
    }

    default:
      return state;
  }
}

/**
 * イベント配列から状態を計算
 */
export function computeState(events: WbelxEvent[]): WbelxState {
  let state = createInitialState();

  for (const event of events) {
    state = applyEvent(state, event);
  }

  return state;
}

// ========================================
// アクティブな要素を取得
// ========================================

/**
 * アクティブなストロークを取得
 */
export function getActiveStrokes(state: WbelxState): DrawEvent[] {
  const result: DrawEvent[] = [];
  for (const id of state.activeStrokeIds) {
    const stroke = state.strokes.get(id);
    if (stroke) {
      result.push(stroke);
    }
  }
  return result;
}

/**
 * アクティブなオーバーレイを取得（z_index でソート）
 */
export function getActiveOverlays(state: WbelxState): OverlayState[] {
  const result: OverlayState[] = [];
  for (const id of state.activeOverlayIds) {
    const overlay = state.overlays.get(id);
    if (overlay) {
      result.push(overlay);
    }
  }
  // z_index で昇順ソート（小さい方が後ろ）
  result.sort((a, b) => a.zIndex - b.zIndex);
  return result;
}

// ========================================
// OA イベントへの変換（スナップショット用）
// ========================================

/**
 * OverlayState を OA イベントに変換（スナップショット用）
 */
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
