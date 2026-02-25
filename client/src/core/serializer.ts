/**
 * core/serializer.ts — wbelx JSONL シリアライザー（Rust 移植対象）
 *
 * utils/wbelx-parser.ts から Core 層に必要なシリアライズ関数を抽出。
 * ブラウザ API / React / Yjs に非依存。
 *
 * 参照仕様:
 *   wbel-implementation-guide v4 §BATCH の hydrate / dehydrate
 *   wbelx-spec v4 §BATCH イベント
 */

import type {
  WbelxEvent,
  SubEvent,
  BatchEvent,
  WbelxHeaderEvent,
} from './types';

// ========================================
// イベント → JSONL 1行
// ========================================

/**
 * イベントを JSONL 1行にシリアライズする。
 * BATCH のサブイベントからは timestamp/sessionId を除去する (dehydrate)。
 */
export function eventToJsonl(event: WbelxEvent): string {
  if (event.type === 'BATCH') {
    const batch = event as BatchEvent;
    // サブイベントから timestamp/sessionId を dehydrate
    const dehydrated = batch.events.map(sub => {
      const { timestamp: _t, sessionId: _s, ...rest } = sub as SubEvent & { timestamp: string; sessionId: string };
      return rest;
    });
    return JSON.stringify({
      type: 'BATCH',
      id: batch.id,
      timestamp: batch.timestamp,
      sessionId: batch.sessionId,
      events: dehydrated,
    });
  }
  return JSON.stringify(event);
}

// ========================================
// イベント列 → wbelx ファイル内容
// ========================================

/**
 * イベント列を wbelx v4 JSONL 形式にシリアライズする。
 *
 * @param events - イベント列
 * @param createdAt - ヘッダーの createdAt（外部から注入）
 * @param canvasWidth - キャンバス幅
 * @param canvasHeight - キャンバス高さ
 */
export function eventsToWbelxContent(
  events: ReadonlyArray<WbelxEvent>,
  createdAt: string,
  canvasWidth = 0,
  canvasHeight = 0,
): string {
  const header: WbelxHeaderEvent = {
    type: 'H',
    version: 4,
    createdAt,
    canvasWidth,
    canvasHeight,
  };
  const lines = [JSON.stringify(header), ...events.map(eventToJsonl)];
  return lines.join('\n');
}
