/**
 * wbelx ステートマシン v4
 *
 * v3.1 → v4 変更点:
 * - E: targetId 単一対象
 * - OR: targetOverlayId 単一対象
 * - OS: 単一ターゲット（overlayId, dzIndex?, dOpacity?）
 * - BATCH: サブイベントを逐次適用
 */

import type {
  DrawEvent,
  WbelxEvent,
  WbelxState,
  OverlayState,
  OverlayAddEvent,
  BackgroundState,
  BackgroundEvent,
  ViewportDelta,
  Viewport,
  SubEvent,
} from './types';

import { BG_SPEC_DEFAULTS } from './types';

// ========================================
// clamp ヘルパー
// ========================================

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function clampColor(value: number): number {
  return Math.round(clamp(value, 0, 255));
}

// ========================================
// 初期状態
// ========================================

export function createInitialState(): WbelxState {
  return {
    activeStrokeIds: new Set(),
    strokes: new Map(),
    activeOverlayIds: new Set(),
    overlays: new Map(),
    background: null,
    canvasWidth: 0,
    canvasHeight: 0,
  };
}

// ========================================
// BG 初期化ヘルパー
// ========================================

function ensureBackground(bg: BackgroundState | null): BackgroundState {
  if (bg !== null) return bg;
  return {
    color: { ...BG_SPEC_DEFAULTS.color },
    pattern: BG_SPEC_DEFAULTS.pattern,
    patternSize: BG_SPEC_DEFAULTS.patternSize,
    patternColor: { ...BG_SPEC_DEFAULTS.patternColor },
  };
}

// ========================================
// デルタ適用ヘルパー
// ========================================

function applyViewportDelta(vp: Viewport, d: ViewportDelta): Viewport {
  return {
    x:      vp.x      + (d.dx     ?? 0),
    y:      vp.y      + (d.dy     ?? 0),
    width:  clamp(vp.width  + (d.dWidth  ?? 0), 1, Infinity),
    height: clamp(vp.height + (d.dHeight ?? 0), 1, Infinity),
  };
}

// ========================================
// サブイベント適用（BATCH 内部でも使用）
// ========================================

function applySubEvent(state: WbelxState, event: SubEvent): WbelxState {
  switch (event.type) {
    case 'D': {
      const newStrokes = new Map(state.strokes);
      newStrokes.set(event.id, event);
      const newActiveIds = new Set(state.activeStrokeIds);
      newActiveIds.add(event.id);
      return { ...state, activeStrokeIds: newActiveIds, strokes: newStrokes };
    }

    case 'E': {
      // v4: 単一対象
      const newActiveIds = new Set(state.activeStrokeIds);
      newActiveIds.delete(event.targetId);
      return { ...state, activeStrokeIds: newActiveIds };
    }

    case 'OA': {
      const overlayState: OverlayState = {
        overlayId: event.overlayId,
        assetUuid: event.assetUuid,
        x: event.x,
        y: event.y,
        width: event.width,
        height: event.height,
        rotation: event.rotation,
        viewport: { ...event.viewport },
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
      // v4: 単一対象
      const newActiveOverlayIds = new Set(state.activeOverlayIds);
      newActiveOverlayIds.delete(event.targetOverlayId);
      return { ...state, activeOverlayIds: newActiveOverlayIds };
    }

    case 'OT': {
      const existing = state.overlays.get(event.overlayId);
      if (!existing) return state;
      const updated: OverlayState = {
        ...existing,
        x:        existing.x        + (event.dx        ?? 0),
        y:        existing.y        + (event.dy        ?? 0),
        width:    clamp(existing.width    + (event.dWidth    ?? 0), 1, Infinity),
        height:   clamp(existing.height   + (event.dHeight   ?? 0), 1, Infinity),
        rotation: existing.rotation + (event.dRotation ?? 0),
      };
      const newOverlays = new Map(state.overlays);
      newOverlays.set(event.overlayId, updated);
      return { ...state, overlays: newOverlays };
    }

    case 'OV': {
      const existing = state.overlays.get(event.overlayId);
      if (!existing) return state;
      const updated: OverlayState = { ...existing };
      if (event.dViewport) {
        updated.viewport = applyViewportDelta(existing.viewport, event.dViewport);
      }
      if (event.dPage !== undefined) {
        updated.page = clamp(existing.page + event.dPage, 1, Infinity);
      }
      const newOverlays = new Map(state.overlays);
      newOverlays.set(event.overlayId, updated);
      return { ...state, overlays: newOverlays };
    }

    case 'OS': {
      // v4: 単一ターゲット
      const existing = state.overlays.get(event.overlayId);
      if (!existing) return state;
      const newOverlays = new Map(state.overlays);
      newOverlays.set(event.overlayId, {
        ...existing,
        zIndex:  clamp(existing.zIndex  + (event.dzIndex  ?? 0), 1, Infinity),
        opacity: clamp(existing.opacity + (event.dOpacity ?? 0), 0.0, 1.0),
      });
      return { ...state, overlays: newOverlays };
    }

    case 'BG': {
      const bg = ensureBackground(state.background);
      const updated: BackgroundState = { ...bg };

      if (event.dColor) {
        const c = bg.color!;
        updated.color = {
          r: clampColor(c.r + event.dColor.dr),
          g: clampColor(c.g + event.dColor.dg),
          b: clampColor(c.b + event.dColor.db),
        };
      }
      if (event.pattern) {
        updated.pattern = event.pattern.next;
      }
      if (event.dPatternSize !== undefined) {
        updated.patternSize = clamp(bg.patternSize! + event.dPatternSize, 1, Infinity);
      }
      if (event.dPatternColor) {
        const c = bg.patternColor!;
        updated.patternColor = {
          r: clampColor(c.r + event.dPatternColor.dr),
          g: clampColor(c.g + event.dPatternColor.dg),
          b: clampColor(c.b + event.dPatternColor.db),
        };
      }

      return { ...state, background: updated };
    }

    case 'CS': {
      const w = event.dCanvasWidth !== undefined
        ? Math.max(0, state.canvasWidth + event.dCanvasWidth)
        : state.canvasWidth;
      const h = event.dCanvasHeight !== undefined
        ? Math.max(0, state.canvasHeight + event.dCanvasHeight)
        : state.canvasHeight;
      return { ...state, canvasWidth: w, canvasHeight: h };
    }

    default:
      return state;
  }
}

// ========================================
// トップレベルイベント適用
// ========================================

export function applyEvent(state: WbelxState, event: WbelxEvent): WbelxState {
  switch (event.type) {
    case 'S':
      return state;

    case 'BATCH': {
      // サブイベントを逐次適用
      let s = state;
      for (const sub of event.events) {
        s = applySubEvent(s, sub);
      }
      return s;
    }

    default:
      // SubEvent（D, E, OA, OR, OT, OV, OS, BG, CS）
      return applySubEvent(state, event);
  }
}

// ========================================
// 全イベントから状態を再計算
// ========================================

export function computeState(events: WbelxEvent[]): WbelxState {
  let state = createInitialState();
  for (const event of events) {
    state = applyEvent(state, event);
  }
  state = normalizeZIndexIfNeeded(state);
  return state;
}

/**
 * activeOverlays の zIndex に重複がある場合、overlayId 辞書順昇順で連番を振り直す。
 */
function normalizeZIndexIfNeeded(state: WbelxState): WbelxState {
  const activeIds = Array.from(state.activeOverlayIds);
  if (activeIds.length <= 1) return state;

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
    viewport: { ...overlay.viewport },
    page: overlay.page,
    zIndex: overlay.zIndex,
    opacity: overlay.opacity,
  };
}

// ========================================
// BG 状態からスナップショット用 BG イベントを生成
// ========================================

export function backgroundStateToSnapshotBGEvent(
  bg: BackgroundState | null,
  timestamp: string,
  sessionId: string,
  id: string
): BackgroundEvent | null {
  if (bg === null) return null;

  const defaults = BG_SPEC_DEFAULTS;
  const event: BackgroundEvent = {
    type: 'BG',
    timestamp,
    sessionId,
    id,
  };

  if (bg.color !== null) {
    event.dColor = {
      space: 'srgb',
      dr: bg.color.r - defaults.color.r,
      dg: bg.color.g - defaults.color.g,
      db: bg.color.b - defaults.color.b,
    };
  }
  if (bg.pattern !== null && bg.pattern !== defaults.pattern) {
    event.pattern = { prev: defaults.pattern, next: bg.pattern };
  }
  if (bg.patternSize !== null) {
    event.dPatternSize = bg.patternSize - defaults.patternSize;
  }
  if (bg.patternColor !== null) {
    event.dPatternColor = {
      space: 'srgb',
      dr: bg.patternColor.r - defaults.patternColor.r,
      dg: bg.patternColor.g - defaults.patternColor.g,
      db: bg.patternColor.b - defaults.patternColor.b,
    };
  }

  return event;
}