/**
 * hooks/useBackground.ts — 背景変更ハンドラ（L3 Shell）
 *
 * 移動元: BoardEditor.tsx の handleBackgroundChange + parseHex
 * Core 層: core/bg-delta.ts (buildBgEvent)
 *
 * Phase 3c: appendEvent + pushOp パターンに移行。
 */

import { useCallback } from 'react';
import { buildBgEvent } from '../core/bg-delta';
import type { BackgroundConfig } from '../core/types';
import type { WbelxEvent, Operation } from '../types';
import { getTimestamp, generateBgOpId } from '../utils/common';

export interface UseBackgroundOptions {
  /** 現在の背景設定（null の場合は変更不可） */
  currentBackground: BackgroundConfig | undefined;
  /** セッション ID */
  sessionId: string;
  /** イベントを Yjs に追加 */
  appendEvent: (event: WbelxEvent) => void;
  /** Undo スタックに操作を追加 */
  pushOp: (op: Operation) => void;
  /** プロジェクトストアの背景更新（永続化用） */
  updateBackground: (config: BackgroundConfig) => void;
}

export interface UseBackgroundReturn {
  handleBackgroundChange: (newConfig: BackgroundConfig) => void;
}

/**
 * 背景変更ハンドラを提供する。
 * Toolbar からの背景変更を受けて、BG デルタイベントを生成し発行する。
 */
export function useBackground({
  currentBackground,
  sessionId,
  appendEvent,
  pushOp,
  updateBackground,
}: UseBackgroundOptions): UseBackgroundReturn {
  const handleBackgroundChange = useCallback((newConfig: BackgroundConfig) => {
    if (!currentBackground) return;

    const bgEvent = buildBgEvent(
      currentBackground,
      newConfig,
      sessionId,
      generateBgOpId,
      getTimestamp,
    );

    if (!bgEvent) return;

    appendEvent(bgEvent);
    pushOp({
      type: 'background', id: bgEvent.id,
      ...(bgEvent.dColor && { dColor: bgEvent.dColor }),
      ...(bgEvent.pattern && { pattern: bgEvent.pattern }),
      ...(bgEvent.dPatternSize !== undefined && { dPatternSize: bgEvent.dPatternSize }),
      ...(bgEvent.dPatternColor && { dPatternColor: bgEvent.dPatternColor }),
    });
    // プロジェクトストアにも反映（永続化用）
    updateBackground(newConfig);
  }, [currentBackground, sessionId, appendEvent, pushOp, updateBackground]);

  return { handleBackgroundChange };
}
