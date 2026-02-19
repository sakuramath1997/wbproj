/**
 * Whiteboard Event Log (.wbel) v6 型定義
 */

// ========================================
// 基本型
// ========================================

/** 2D座標 */
export interface Point {
  x: number;
  y: number;
}

/** 入力点（タイムスタンプ・筆圧付き） */
export interface InputPoint extends Point {
  timestamp?: number;   // ミリ秒
  pressure?: number;    // 0.0 - 1.0
}

/** バウンディングボックス [minX, minY, maxX, maxY] */
export type BBox = [number, number, number, number];

// ========================================
// イベント型
// ========================================

/** ヘッダーイベント */
export interface HeaderEvent {
  type: 'H';
  version: number;
  createdAt: string;      // ISO 8601
}

/** Draw イベント */
export interface DrawEvent {
  type: 'D';
  timestamp: string;      // ISO 8601
  sessionId: string;      // セッション識別子（最大32文字）
  id: string;             // ストロークID (s:xxx)
  color: string;          // 色 (hex)
  width: number;          // 線幅
  bbox: BBox;             // [minX, minY, maxX, maxY]
  path: string;           // SVGパス文字列
}

/** Erase イベント */
export interface EraseEvent {
  type: 'E';
  timestamp: string;      // ISO 8601
  sessionId: string;      // セッション識別子
  id: string;             // 消去操作ID (e:xxx)
  targetIds: string[];    // 消去対象のストロークID配列
}

/** Snapshot Marker イベント */
export interface SnapshotMarkerEvent {
  type: 'S';
  timestamp: string;      // ISO 8601
  sessionId: string;      // セッション識別子
  snapshotHash: string;   // スナップショットファイルのハッシュ
}

/** wbel イベント（統合型） */
export type WbelEvent = DrawEvent | EraseEvent | SnapshotMarkerEvent;

// ========================================
// Undo/Redo 操作記録
// ========================================

/** Draw 操作記録 */
export interface DrawOperation {
  type: 'draw';
  strokeId: string;
  strokeData: DrawEvent;
}

/** Erase 操作記録 */
export interface EraseOperation {
  type: 'erase';
  eraseId: string;
  targetIds: string[];
  targetStrokes: DrawEvent[];
}

/** 操作記録（統合型） */
export type StrokeOperation = DrawOperation | EraseOperation;

// ========================================
// 状態管理
// ========================================

/** ホワイトボード状態 */
export interface WhiteboardState {
  activeIds: Set<string>;           // 現在表示中のストロークID
  strokes: Map<string, DrawEvent>;  // ID → DrawEvent のマップ
}

// ========================================
// 描画中のストローク
// ========================================

export interface ActiveStroke {
  id: string;
  points: InputPoint[];
  color: string;
  width: number;
}

// ========================================
// ツール関連
// ========================================

export type ToolType = 'pen' | 'eraser' | 'pan' | 'select' | 'lasso';
export type StrokeWidthKey = 'thin' | 'medium' | 'thick';

export const COLOR_PALETTE = [
  '#1a1a1a', // Black
  '#ef4444', // Red
  '#f97316', // Orange
  '#eab308', // Yellow
  '#22c55e', // Green
  '#3b82f6', // Blue
  '#8b5cf6', // Purple
  '#ec4899', // Pink
] as const;

export const STROKE_WIDTHS: Record<StrokeWidthKey, number> = {
  thin: 2,
  medium: 5,
  thick: 10,
};

// ========================================
// キャンバス変換
// ========================================

export interface CanvasTransform {
  x: number;
  y: number;
  scale: number;
}

// ========================================
// カーソル情報（P2P）
// ========================================

export interface CursorInfo {
  id: string;
  name: string;
  x: number;
  y: number;
  color: string;
}
