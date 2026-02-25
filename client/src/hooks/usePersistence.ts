/**
 * hooks/usePersistence.ts — 永続化・エクスポート（L3 Shell）
 *
 * 移動元: BoardEditor.tsx の IndexedDB 自動保存、handleBack、
 *         handleCopyShareLink、エクスポート系ハンドラ
 *
 * Core 層: core/snapshot-builder.ts（将来的に handleBack で使用）
 */

import { useCallback, useEffect, useRef } from 'react';
import type {
  WbelxEvent,
  DrawEvent,
  OverlayState,
  SnapshotMarkerEvent,
  WbelxState,
} from '../types';
import type { BackgroundConfig } from '../types/project';
import { getTimestamp, generateSnapshotId, generateBgOpId, generateCsOpId } from '../utils/common';
import {
  saveBoardEvents,
  saveBoardSnapshot,
  deleteBoardSnapshot,
} from '../utils/storage';
import {
  exportAsPng,
  exportAsSvg,
  downloadBlob,
  downloadString,
} from '../utils/export';
import { buildSnapshotContent, flattenSnapshotContent } from '../core/snapshot-builder';

// ========================================
// 型定義
// ========================================

export interface UsePersistenceOptions {
  isHost: boolean;
  boardId: string | undefined;
  boardName: string | undefined;
  sessionId: string;
  roomId: string;
  events: WbelxEvent[];
  /** ステートマシンの現在の状態（スナップショット生成に使用） */
  state: WbelxState;
  activeStrokes: DrawEvent[];
  activeOverlays: OverlayState[];
  overlayImages: Map<string, HTMLImageElement>;
  background: BackgroundConfig | undefined;
  canvasSize: { width: number; height: number } | undefined;
  guestsPresent: boolean;
  isJoiningViaShareLink: boolean;
  navigate: (path: string) => void;
  /** useYjsSync の wbelx エクスポート */
  exportWbelx: () => string;
  /** useYjsSync のスナップショット wbelx エクスポート */
  exportSnapshotWbelx: () => string;
  /** サムネイル再生成 */
  regenerateThumbnail: (boardId: string, strokes: DrawEvent[], overlays: OverlayState[]) => Promise<void>;
}

export interface UsePersistenceReturn {
  handleBack: () => Promise<void>;
  handleCopyShareLink: () => void;
  handleExportWbelx: () => void;
  handleExportSnapshot: () => void;
  handleExportPng: () => void;
  handleExportSvg: () => void;
}

export function usePersistence({
  isHost,
  boardId,
  boardName,
  sessionId,
  roomId,
  events,
  state,
  activeStrokes,
  activeOverlays,
  overlayImages,
  background,
  canvasSize,
  guestsPresent,
  isJoiningViaShareLink,
  navigate,
  exportWbelx,
  exportSnapshotWbelx,
  regenerateThumbnail,
}: UsePersistenceOptions): UsePersistenceReturn {
  // ========================================
  // イベント変更時：IndexedDB に即時保存
  // ========================================
  const lastSavedEventCountRef = useRef(0);

  useEffect(() => {
    if (!isHost || !boardId) return;
    if (events.length === 0) return;
    if (events.length === lastSavedEventCountRef.current) return;

    const save = async () => {
      await saveBoardEvents(boardId, events);
      lastSavedEventCountRef.current = events.length;
    };

    save();
  }, [isHost, boardId, events]);

  // ========================================
  // 戻るボタン：S イベント + スナップショット保存
  // ========================================
  const handleBack = useCallback(async () => {
    if (isHost && boardId && events.length > 0) {
      // S イベントを追加
      const snapshotMarker: SnapshotMarkerEvent = {
        type: 'S',
        timestamp: getTimestamp(),
        sessionId,
        snapshotHash: generateSnapshotId(),
      };
      const eventsWithS = [...events, snapshotMarker];

      // イベントログを保存
      await saveBoardEvents(boardId, eventsWithS);

      // スナップショットを保存（wbelx-spec v4 §7 準拠: D + OA + BG累積行 + CS累積行）
      const ts = getTimestamp();
      const snapshotContent = buildSnapshotContent(
        state,
        ts,
        sessionId,
        generateBgOpId,
        generateCsOpId,
      );
      const snapshotEvents = flattenSnapshotContent(snapshotContent);
      await saveBoardSnapshot(boardId, snapshotEvents);

      // サムネイル再生成
      try {
        await regenerateThumbnail(boardId, activeStrokes, activeOverlays);
      } catch { /* ignore */ }
    }

    navigate(isJoiningViaShareLink ? '/' : '/project');
  }, [isHost, boardId, events, sessionId, state, activeStrokes, activeOverlays, navigate, isJoiningViaShareLink, regenerateThumbnail]);

  // ========================================
  // ゲストがいる場合はスナップショットをクリア
  // ========================================
  useEffect(() => {
    if (isHost && boardId && guestsPresent) {
      deleteBoardSnapshot(boardId);
    }
  }, [isHost, boardId, guestsPresent]);

  // ========================================
  // 共有リンクをコピー
  // ========================================
  const handleCopyShareLink = useCallback(() => {
    const baseUrl = `${window.location.origin}${window.location.pathname}`;
    const shareUrl = `${baseUrl}?room=${encodeURIComponent(roomId)}`;
    navigator.clipboard.writeText(shareUrl).catch(() => {
      prompt('Share this link:', shareUrl);
    });
  }, [roomId]);

  // ========================================
  // エクスポート
  // ========================================
  const handleExportWbelx = useCallback(() => {
    const content = exportWbelx();
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${boardName || 'board'}.wbelx`;
    a.click();
    URL.revokeObjectURL(url);
  }, [exportWbelx, boardName]);

  const handleExportSnapshot = useCallback(() => {
    const content = exportSnapshotWbelx();
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${boardName || 'board'}.snap.wbelx`;
    a.click();
    URL.revokeObjectURL(url);
  }, [exportSnapshotWbelx, boardName]);

  const handleExportPng = useCallback(() => {
    const blob = exportAsPng(activeStrokes, activeOverlays, overlayImages, {
      dpr: 2,
      background,
      canvasSize: canvasSize || undefined,
    });
    if (blob) downloadBlob(blob, `${boardName || 'board'}.png`);
  }, [activeStrokes, activeOverlays, overlayImages, background, canvasSize, boardName]);

  const handleExportSvg = useCallback(() => {
    const svg = exportAsSvg(activeStrokes, activeOverlays, overlayImages, {
      background,
      canvasSize: canvasSize || undefined,
    });
    downloadString(svg, `${boardName || 'board'}.svg`, 'image/svg+xml');
  }, [activeStrokes, activeOverlays, overlayImages, background, canvasSize, boardName]);

  return {
    handleBack,
    handleCopyShareLink,
    handleExportWbelx,
    handleExportSnapshot,
    handleExportPng,
    handleExportSvg,
  };
}