/**
 * hooks/useKeyboard.ts — キーボードショートカット（L3 Shell）
 *
 * application-spec v3 §Keyboard Shortcuts に準拠。
 * BoardEditor 内のすべてのキーボードショートカットを一元管理する。
 *
 * 対応ショートカット:
 *   P           → Pen tool
 *   E           → Eraser tool
 *   S           → Select tool（仕様準拠）
 *   L           → Lasso tool
 *   Space(hold) → Pan（離すと Pen に戻る）
 *   A           → Asset Panel トグル
 *   1 / 2 / 3   → Stroke width (thin / medium / thick)
 *   Ctrl+Z      → Undo
 *   Ctrl+Shift+Z / Ctrl+Y → Redo
 *   Ctrl+S      → Save
 *   Ctrl+C      → Copy（Lasso 選択中）
 *   Ctrl+V      → Paste（Lasso クリップボード）
 *   Delete / Backspace → 選択中要素を削除
 *   Escape      → 選択解除 / 編集キャンセル
 */

import { useEffect } from 'react';
import type { ToolType, StrokeWidthKey } from '../types/wbel';

export interface UseKeyboardOptions {
  performUndo: () => void;
  performRedo: () => void;
  setTool: (tool: ToolType) => void;
  setStrokeWidthKey: (key: StrokeWidthKey) => void;
  /** Ctrl+S で呼ばれる保存ハンドラ */
  onSave?: () => void;
  /** Ctrl+C で呼ばれるコピーハンドラ（Lasso 選択中のみ呼び出し側で判定） */
  onCopy?: () => void;
  /** Ctrl+V で呼ばれるペーストハンドラ */
  onPaste?: () => void;
  /** Delete/Backspace で呼ばれる削除ハンドラ */
  onDelete?: () => void;
  /** Escape で呼ばれるキャンセルハンドラ */
  onEscape?: () => void;
  /** A キーで呼ばれるアセットパネルトグル */
  onToggleAssetPanel?: () => void;
}

export function useKeyboard({
  performUndo,
  performRedo,
  setTool,
  setStrokeWidthKey,
  onSave,
  onCopy,
  onPaste,
  onDelete,
  onEscape,
  onToggleAssetPanel,
}: UseKeyboardOptions): void {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      // --- 修飾キー付きショートカット ---

      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) { performRedo(); } else { performUndo(); }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        e.preventDefault();
        performRedo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        onSave?.();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        e.preventDefault();
        onCopy?.();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        e.preventDefault();
        onPaste?.();
        return;
      }

      // Ctrl/Meta 修飾キーが押されている場合はこれ以降をスキップ
      if (e.ctrlKey || e.metaKey) return;

      // --- 単独キーショートカット ---

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        onDelete?.();
        return;
      }
      if (e.key === 'Escape') {
        onEscape?.();
        return;
      }

      switch (e.key.toLowerCase()) {
        case 'p': setTool('pen'); break;
        case 'e': setTool('eraser'); break;
        case 's': setTool('select'); break;
        case 'l': setTool('lasso'); break;
        case 'a': onToggleAssetPanel?.(); break;
        case ' ': e.preventDefault(); setTool('pan'); break;
        case '1': setStrokeWidthKey('thin'); break;
        case '2': setStrokeWidthKey('medium'); break;
        case '3': setStrokeWidthKey('thick'); break;
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') setTool('pen');
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [performUndo, performRedo, setTool, setStrokeWidthKey,
      onSave, onCopy, onPaste, onDelete, onEscape, onToggleAssetPanel]);
}
