/**
 * Whiteboard Event Log (.wbel) v8 型定義
 *
 * v7 → v8 変更点:
 * - E.targetIds: string[] → E.targetId: string（単一対象化）
 *   複数ストロークの同時消去は BATCH イベント（wbelx）で表現する
 */

// ========================================
// 基本型
// ========================================

export interface Point {
  x: number;
  y: number;
}

export interface InputPoint extends Point {
  timestamp?: number;
  pressure?: number;
}

export type BBox = [number, number, number, number];

// ========================================
// イベント型
// ========================================

export interface HeaderEvent {
  type: 'H';
  version: number;
  createdAt: string;
}

export interface DrawEvent {
  type: 'D';
  timestamp: string;
  sessionId: string;
  id: string;
  color: string;
  width: number;
  bbox: BBox;
  path: string;
}

/** Erase イベント — 単一対象（v8） */
export interface EraseEvent {
  type: 'E';
  timestamp: string;
  sessionId: string;
  id: string;
  targetId: string;
}

export interface SnapshotMarkerEvent {
  type: 'S';
  timestamp: string;
  sessionId: string;
  snapshotHash: string;
}

export type WbelEvent = DrawEvent | EraseEvent | SnapshotMarkerEvent;

// ========================================
// Undo/Redo 操作記録
// ========================================

export interface DrawOperation {
  type: 'draw';
  strokeId: string;
  strokeData: DrawEvent;
}

export interface EraseOperation {
  type: 'erase';
  eraseId: string;
  targetId: string;
  targetStroke: DrawEvent;
}

export type StrokeOperation = DrawOperation | EraseOperation;

// ========================================
// 状態管理
// ========================================

export interface WhiteboardState {
  activeIds: Set<string>;
  strokes: Map<string, DrawEvent>;
}

// ========================================
// 描画中のストローク
// ========================================

export interface DrawingStroke {
  points: InputPoint[];
  color: string;
  width: number;
}

/** 描画中のストローク（ID 付き） */
export interface ActiveStroke extends DrawingStroke {
  id: string;
}

// ========================================
// カーソル
// ========================================

export interface CursorInfo {
  id: string;
  name: string;
  x: number;
  y: number;
  color: string;
}

// ========================================
// ツール
// ========================================

export type ToolType = 'pen' | 'eraser' | 'pan' | 'select' | 'lasso';

export type StrokeWidthKey = 'thin' | 'medium' | 'thick' | 'extraThick';

export const STROKE_WIDTHS: Record<StrokeWidthKey, number> = {
  thin: 2,
  medium: 4,
  thick: 8,
  extraThick: 16,
};

export const COLOR_PALETTE = [
  '#1e1e1e', '#e03131', '#2f9e44', '#1971c2',
  '#f08c00', '#9c36b5', '#ffffff',
];

// ========================================
// Canvas トランスフォーム
// ========================================

export interface CanvasTransform {
  x: number;
  y: number;
  scale: number;
}
