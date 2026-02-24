/**
 * wbelx Minimize ユーティリティ
 *
 * wbel-spec v7 §7 / wbelx-spec v3.1 §7 に準拠した破壊的操作。
 * イベント履歴を除去し、現在の描画状態のみを保持する。
 *
 * 手順:
 *   1. 全イベントをリプレイして現在の状態を取得
 *   2. アクティブストロークの最新 D イベントのみ保持（timestamp 昇順）
 *   3. アクティブオーバーレイを OA イベントとして出力（現在の状態を絶対値で記録、zIndex 昇順）
 *   4. 背景設定がある場合、仕様デフォルトからの累積デルタとして BG イベントを 1 行出力
 *   5. E, OR, OT, OV, OS, S, BATCH イベントをすべて除去
 *   6. 新しい H ヘッダー（version: 4）で wbelx ファイルを生成
 *
 * 注意: Undo/Redo 履歴が失われる破壊的操作。
 *       プロジェクト画面でのボード操作として新規ファイルを作成する。
 */

import type {
  WbelxEvent,
  OverlayAddEvent,
  WbelxHeaderEvent,
  OverlayState,
} from '../types';
import { computeState, getActiveStrokes, getActiveOverlays, backgroundStateToSnapshotBGEvent } from './statemachine';
import { eventToJsonl } from './wbelx-parser';
import { generateBgOpId, getTimestamp } from './common';

// ========================================
// Minimize 結果
// ========================================

export interface MinimizeResult {
  /** Minimize 後の wbelx ファイル内容（JSONL 文字列） */
  content: string;
  /** Minimize 後のイベント配列 */
  events: WbelxEvent[];
  /** Minimize 前のイベント数 */
  beforeEventCount: number;
  /** Minimize 後のイベント数 */
  afterEventCount: number;
  /** アクティブストローク数 */
  activeStrokeCount: number;
  /** アクティブオーバーレイ数 */
  activeOverlayCount: number;
  /** 背景設定の有無 */
  hasBackground: boolean;
}

// ========================================
// Minimize 実装
// ========================================

/**
 * wbelx イベント列を Minimize する。
 *
 * @param events - 元のイベント列
 * @param canvasWidth - キャンバス幅（ヘッダーに記録）
 * @param canvasHeight - キャンバス高さ（ヘッダーに記録）
 * @returns MinimizeResult
 */
export function minimizeWbelx(
  events: WbelxEvent[],
  canvasWidth = 0,
  canvasHeight = 0,
): MinimizeResult {
  // 1. 全イベントをリプレイして現在の状態を取得
  const state = computeState(events);

  const ts = getTimestamp();
  const sid = '__minimize__';
  const outputEvents: WbelxEvent[] = [];

  // 2. アクティブストロークの D イベント（timestamp 昇順）
  const activeStrokes = getActiveStrokes(state);
  activeStrokes.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  for (const stroke of activeStrokes) {
    outputEvents.push(stroke);
  }

  // 3. アクティブオーバーレイを OA イベントとして（zIndex 昇順 — getActiveOverlays はソート済み）
  const activeOverlays = getActiveOverlays(state);
  for (const overlay of activeOverlays) {
    const oaEvent: OverlayAddEvent = overlayToOA(overlay, ts, sid);
    outputEvents.push(oaEvent);
  }

  // 4. 背景設定がある場合、仕様デフォルトからの累積デルタとして BG を 1 行出力
  let hasBackground = false;
  if (state.background !== null) {
    const bgEvent = backgroundStateToSnapshotBGEvent(
      state.background, ts, sid, generateBgOpId(),
    );
    if (bgEvent) {
      outputEvents.push(bgEvent);
      hasBackground = true;
    }
  }

  // 5. CS イベント: キャンバスサイズが canvasWidth/canvasHeight と異なる場合は
  //    ヘッダーの canvasWidth/canvasHeight で反映するため不要。
  //    state.canvasWidth / state.canvasHeight をヘッダーに使用する。
  const effectiveCanvasWidth = state.canvasWidth || canvasWidth;
  const effectiveCanvasHeight = state.canvasHeight || canvasHeight;

  // 6. ヘッダー + イベント列を JSONL で出力
  const header: WbelxHeaderEvent = {
    type: 'H',
    version: 4,
    createdAt: new Date().toISOString(),
    canvasWidth: effectiveCanvasWidth,
    canvasHeight: effectiveCanvasHeight,
  };

  const lines = [
    JSON.stringify(header),
    ...outputEvents.map(eventToJsonl),
  ];

  return {
    content: lines.join('\n'),
    events: outputEvents,
    beforeEventCount: events.length,
    afterEventCount: outputEvents.length,
    activeStrokeCount: activeStrokes.length,
    activeOverlayCount: activeOverlays.length,
    hasBackground,
  };
}

// ========================================
// ヘルパー
// ========================================

/** OverlayState → OA イベント */
function overlayToOA(overlay: OverlayState, timestamp: string, sessionId: string): OverlayAddEvent {
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
