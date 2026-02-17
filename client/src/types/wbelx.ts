/**
 * Whiteboard Extended Event Log (.wbelx) v1 型定義
 * 
 * .wbel v5 のスーパーセット。オーバーレイ操作を追加。
 */

import type { DrawEvent, EraseEvent, SnapshotMarkerEvent, StrokeOperation } from './wbel';

// Re-export wbel types
export * from './wbel';

// ========================================
// Viewport 型
// ========================================

/** 表示領域（SVG viewBox と同じ順序: min-x, min-y, width, height） */
export interface Viewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Viewport を文字列に変換 (x;y;w;h) */
export function viewportToString(vp: Viewport): string {
  return `${vp.x};${vp.y};${vp.width};${vp.height}`;
}

/** 文字列から Viewport をパース */
export function parseViewport(str: string): Viewport {
  const [x, y, width, height] = str.split(';').map(Number);
  return { x, y, width, height };
}

// ========================================
// オーバーレイイベント型
// ========================================

/** Overlay Add イベント */
export interface OverlayAddEvent {
  type: 'OA';
  timestamp: string;
  sessionId: string;
  overlayId: string;        // o:xxx
  assetUuid: string;        // 参照先アセットの UUID
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;         // 度、時計回り
  viewport: Viewport;
  page: number;             // PDF ページ（1-indexed、非PDF は 0）
  zIndex: number;
  opacity: number;          // 0.0-1.0
}

/** Overlay Remove イベント */
export interface OverlayRemoveEvent {
  type: 'OR';
  timestamp: string;
  sessionId: string;
  removeId: string;         // r:xxx
  targetOverlayIds: string[];
}

/** Overlay Transform イベント（移動・リサイズ・回転） */
export interface OverlayTransformEvent {
  type: 'OT';
  timestamp: string;
  sessionId: string;
  overlayId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}

/** Overlay Viewport イベント（表示領域・ページ変更） */
export interface OverlayViewportEvent {
  type: 'OV';
  timestamp: string;
  sessionId: string;
  overlayId: string;
  viewport: Viewport;
  page: number;
}

/** Overlay Style イベント（z_index・opacity 変更） */
export interface OverlayStyleEvent {
  type: 'OS';
  timestamp: string;
  sessionId: string;
  overlayId: string;
  zIndex: number;
  opacity: number;
}

/** オーバーレイイベント（統合型） */
export type OverlayEvent =
  | OverlayAddEvent
  | OverlayRemoveEvent
  | OverlayTransformEvent
  | OverlayViewportEvent
  | OverlayStyleEvent;

/** wbelx イベント（統合型） */
export type WbelxEvent =
  | DrawEvent
  | EraseEvent
  | SnapshotMarkerEvent
  | OverlayEvent;

// ========================================
// オーバーレイ状態
// ========================================

/** オーバーレイの現在の状態 */
export interface OverlayState {
  overlayId: string;
  assetUuid: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  viewport: Viewport;
  page: number;
  zIndex: number;
  opacity: number;
}

// ========================================
// オーバーレイ Undo/Redo 操作記録
// ========================================

/** Overlay Add 操作記録 */
export interface OverlayAddOperation {
  type: 'overlayAdd';
  overlayId: string;
  overlayData: OverlayAddEvent;
}

/** Overlay Remove 操作記録 */
export interface OverlayRemoveOperation {
  type: 'overlayRemove';
  removeId: string;
  targetOverlayIds: string[];
  targetOverlays: OverlayAddEvent[];  // Undo 用
}

/** Overlay Transform 操作記録 */
export interface OverlayTransformOperation {
  type: 'overlayTransform';
  overlayId: string;
  before: { x: number; y: number; width: number; height: number; rotation: number };
  after: { x: number; y: number; width: number; height: number; rotation: number };
}

/** Overlay Viewport 操作記録 */
export interface OverlayViewportOperation {
  type: 'overlayViewport';
  overlayId: string;
  before: { viewport: Viewport; page: number };
  after: { viewport: Viewport; page: number };
}

/** Overlay Style 操作記録 */
export interface OverlayStyleOperation {
  type: 'overlayStyle';
  overlayId: string;
  before: { zIndex: number; opacity: number };
  after: { zIndex: number; opacity: number };
}

/** オーバーレイ操作記録（統合型） */
export type OverlayOperation =
  | OverlayAddOperation
  | OverlayRemoveOperation
  | OverlayTransformOperation
  | OverlayViewportOperation
  | OverlayStyleOperation;

/** 全操作記録（ストローク + オーバーレイ） */
export type Operation = StrokeOperation | OverlayOperation;

// ========================================
// 拡張ホワイトボード状態
// ========================================

/** wbelx ホワイトボード状態 */
export interface WbelxState {
  // ストローク
  activeStrokeIds: Set<string>;
  strokes: Map<string, DrawEvent>;
  
  // オーバーレイ
  activeOverlayIds: Set<string>;
  overlays: Map<string, OverlayState>;
}

// ========================================
// 型ガード
// ========================================

export function isOverlayEvent(event: WbelxEvent): event is OverlayEvent {
  return event.type.startsWith('O');
}

export function isStrokeEvent(event: WbelxEvent): event is DrawEvent | EraseEvent {
  return event.type === 'D' || event.type === 'E';
}

export function isSnapshotEvent(event: WbelxEvent): event is SnapshotMarkerEvent {
  return event.type === 'S';
}
