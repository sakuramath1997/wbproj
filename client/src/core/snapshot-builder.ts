/**
 * core/snapshot-builder.ts — スナップショット生成（Rust 移植対象）
 *
 * React 非依存。ブラウザ API 非依存。
 *
 * 移動元: BoardEditor.tsx 内の handleBack のスナップショット生成部分（1252–1294行）
 *
 * 参照仕様:
 *   wbelx-spec v4 §7:
 *     .wbel v8 のスナップショット形式を継承し、D イベントに加えて
 *     OA イベント、BG イベント、および CS 累積イベントを含める。
 *
 *     スナップショット内の BG: 仕様デフォルト値からの累積デルタとして全フィールドを
 *     含む BG イベントを 1行 記録する。
 *
 *     スナップショット内の CS: H ヘッダーの初期値からの累積デルタとして
 *     CS イベントを 1行 記録する。
 */

import type {
  DrawEvent,
  OverlayAddEvent,
  WbelxEvent,
  WbelxState,
  BackgroundState,
  BackgroundEvent,
  CanvasSizeEvent,
} from './types';
import { BG_SPEC_DEFAULTS } from './types';

// ========================================
// スナップショットコンテンツ
// ========================================

export interface SnapshotContent {
  /** 生存中のストローク (D イベント) */
  drawEvents: DrawEvent[];
  /** 生存中のオーバーレイ (OA イベント) */
  overlayAddEvents: OverlayAddEvent[];
  /** BG 累積行（デフォルトからのデルタ）— null = 変更なし */
  bgLine: BackgroundEvent | null;
  /** CS 累積行（初期値 0,0 からのデルタ）— null = 変更なし */
  csLine: CanvasSizeEvent | null;
}

// ========================================
// スナップショット構築
// ========================================

/**
 * ステートマシン出力からスナップショットコンテンツを構築する。
 *
 * wbelx-spec v4 §7 準拠:
 * - 生存中のストローク (D) とオーバーレイ (OA) を含む
 * - BG 累積行: 仕様デフォルト値からの累積デルタ
 * - CS 累積行: canvasWidth/canvasHeight が 0 以外の場合
 */
export function buildSnapshotContent(
  state: WbelxState,
  timestamp: string,
  sessionId: string,
  generateBgId: () => string,
  generateCsId: () => string,
): SnapshotContent {
  // ---- 生存中のストローク ----
  const drawEvents: DrawEvent[] = [];
  for (const id of state.activeStrokeIds) {
    const s = state.strokes.get(id);
    if (s) drawEvents.push(s);
  }

  // ---- 生存中のオーバーレイ → OA イベント化 ----
  const overlayAddEvents: OverlayAddEvent[] = [];
  for (const id of state.activeOverlayIds) {
    const overlay = state.overlays.get(id);
    if (overlay) {
      overlayAddEvents.push({
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
      });
    }
  }

  // ---- BG 累積行: 仕様デフォルト値からの累積デルタ ----
  const bgLine = buildBgCumulativeLine(state.background, timestamp, sessionId, generateBgId());

  // ---- CS 累積行: canvasWidth/canvasHeight ----
  const csLine = buildCsCumulativeLine(state.canvasWidth, state.canvasHeight, timestamp, sessionId, generateCsId());

  return { drawEvents, overlayAddEvents, bgLine, csLine };
}

/**
 * 背景状態から BG 累積行を構築する。
 * 仕様デフォルト値からの累積デルタとして全フィールドを記録。
 * 背景が null（変更なし）の場合は null を返す。
 */
export function buildBgCumulativeLine(
  bg: BackgroundState | null,
  timestamp: string,
  sessionId: string,
  id: string,
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
    const dr = bg.color.r - defaults.color.r;
    const dg = bg.color.g - defaults.color.g;
    const db = bg.color.b - defaults.color.b;
    if (dr !== 0 || dg !== 0 || db !== 0) {
      event.dColor = { space: 'srgb', dr, dg, db };
    }
  }
  if (bg.pattern !== null && bg.pattern !== defaults.pattern) {
    event.pattern = { prev: defaults.pattern, next: bg.pattern };
  }
  if (bg.patternSize !== null) {
    const dSize = bg.patternSize - defaults.patternSize;
    if (dSize !== 0) event.dPatternSize = dSize;
  }
  if (bg.patternColor !== null) {
    const dr = bg.patternColor.r - defaults.patternColor.r;
    const dg = bg.patternColor.g - defaults.patternColor.g;
    const db = bg.patternColor.b - defaults.patternColor.b;
    if (dr !== 0 || dg !== 0 || db !== 0) {
      event.dPatternColor = { space: 'srgb', dr, dg, db };
    }
  }

  // 全フィールドがデフォルトと同じなら null
  if (!event.dColor && !event.pattern && event.dPatternSize === undefined && !event.dPatternColor) {
    return null;
  }

  return event;
}

/**
 * キャンバスサイズから CS 累積行を構築する。
 * canvasWidth/canvasHeight が両方 0 の場合は null を返す。
 */
export function buildCsCumulativeLine(
  canvasWidth: number,
  canvasHeight: number,
  timestamp: string,
  sessionId: string,
  id: string,
): CanvasSizeEvent | null {
  if (canvasWidth === 0 && canvasHeight === 0) return null;

  return {
    type: 'CS',
    timestamp,
    sessionId,
    id,
    ...(canvasWidth !== 0 && { dCanvasWidth: canvasWidth }),
    ...(canvasHeight !== 0 && { dCanvasHeight: canvasHeight }),
  };
}

/**
 * スナップショットコンテンツを WbelxEvent 配列にフラット化する。
 * 順序: D イベント → OA イベント → BG 累積行 → CS 累積行
 */
export function flattenSnapshotContent(content: SnapshotContent): WbelxEvent[] {
  const events: WbelxEvent[] = [
    ...content.drawEvents,
    ...content.overlayAddEvents,
  ];
  if (content.bgLine) events.push(content.bgLine);
  if (content.csLine) events.push(content.csLine);
  return events;
}