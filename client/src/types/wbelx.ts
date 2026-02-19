/**
 * Whiteboard Extended Event Log (.wbelx) v2 型定義
 *
 * .wbel v6 のスーパーセット。オーバーレイ操作を追加。
 */

import type { DrawEvent, EraseEvent, SnapshotMarkerEvent, StrokeOperation } from './wbel';

// Re-export wbel types
export * from './wbel';

// ========================================
// スナップショットヘッダー
// ========================================

/** スナップショットヘッダーイベント */
export interface SnapshotHeaderEvent {
  type: 'SS';
  version: number;
  hash: string;
  createdAt: string;      // ISO 8601
}

// ========================================
// Viewport 型
// ========================================

/** 表示領域 */
export interface Viewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ========================================
// オーバーレイイベント型
// ========================================

/** Overlay Add イベント */
export interface OverlayAddEvent {
  type: 'OA';
  timestamp: string;
  sessionId: string;
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

/** Overlay Remove イベント */
export interface OverlayRemoveEvent {
  type: 'OR';
  timestamp: string;
  sessionId: string;
  removeId: string;
  targetOverlayIds: string[];
}

/**
 * Overlay Transform イベント（移動・リサイズ・回転）
 * 差分記録方式: 変更されたフィールドのみを含める。
 * x, y, width, height, rotation のうち少なくとも1つは必須。
 */
export interface OverlayTransformEvent {
  type: 'OT';
  timestamp: string;
  sessionId: string;
  overlayId: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
}

/**
 * Overlay Viewport イベント（表示領域・ページ変更）
 * 差分記録方式: 変更されたフィールドのみを含める。
 * viewport, page のうち少なくとも1つは必須。
 */
export interface OverlayViewportEvent {
  type: 'OV';
  timestamp: string;
  sessionId: string;
  overlayId: string;
  viewport?: Viewport;
  page?: number;
}

/** OS イベントの個別ターゲット */
export interface OverlayStyleTarget {
  overlayId: string;
  zIndex?: number;
  opacity?: number;
}

/**
 * Overlay Style イベント（zIndex・opacity 変更）
 * 複数オーバーレイを1イベントで変更できる。
 * 差分記録方式: 各ターゲットで変更されたフィールドのみを含める。
 */
export interface OverlayStyleEvent {
  type: 'OS';
  timestamp: string;
  sessionId: string;
  targets: OverlayStyleTarget[];
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
  targetOverlays: OverlayAddEvent[];
}

/**
 * Overlay Transform 操作記録
 * before/after は変更されたフィールドのみを保持する（差分）
 */
export interface OverlayTransformOperation {
  type: 'overlayTransform';
  overlayId: string;
  before: Partial<{ x: number; y: number; width: number; height: number; rotation: number }>;
  after: Partial<{ x: number; y: number; width: number; height: number; rotation: number }>;
}

/**
 * Overlay Viewport 操作記録
 * before/after は変更されたフィールドのみを保持する（差分）
 */
export interface OverlayViewportOperation {
  type: 'overlayViewport';
  overlayId: string;
  before: Partial<{ viewport: Viewport; page: number }>;
  after: Partial<{ viewport: Viewport; page: number }>;
}

/**
 * Overlay Style 操作記録
 * OS が複数ターゲット対応になったため、変更リストとして保持する
 */
export interface OverlayStyleOperation {
  type: 'overlayStyle';
  changes: Array<{
    overlayId: string;
    before: Partial<{ zIndex: number; opacity: number }>;
    after: Partial<{ zIndex: number; opacity: number }>;
  }>;
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
