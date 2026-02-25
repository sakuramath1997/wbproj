/**
 * Whiteboard Extended Event Log (.wbelx) v4 型定義
 *
 * v3.1 → v4 変更点:
 * - OR.targetOverlayIds: string[] → OR.targetOverlayId: string（単一対象化）
 * - OS.targets: OverlayStyleTarget[] → OS 自体が単一ターゲット（overlayId, dzIndex?, dOpacity?）
 * - BATCH イベント型の導入（アトミックグループ）
 * - LassoMoveOperation の廃止（BATCH に統合）
 * - E.targetIds → E.targetId（wbel v8 に追従）
 */

import type { DrawEvent, EraseEvent, SnapshotMarkerEvent, StrokeOperation } from './wbel';

export * from './wbel';

// ========================================
// wbelx ヘッダー
// ========================================

export interface WbelxHeaderEvent {
  type: 'H';
  version: 4;
  createdAt: string;
  canvasWidth: number;
  canvasHeight: number;
}

// ========================================
// スナップショットヘッダー
// ========================================

export interface SnapshotHeaderEvent {
  type: 'SS';
  version: number;
  hash: string;
  createdAt: string;
}

// ========================================
// Viewport 型
// ========================================

export interface Viewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ========================================
// デルタ記録方式（§2-2）
// ========================================

export interface ColorDelta {
  space: 'srgb';
  dr: number;
  dg: number;
  db: number;
}

export interface EnumDelta<T extends string = string> {
  prev: T;
  next: T;
}

// ========================================
// オーバーレイイベント型
// ========================================

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

/** Overlay Remove — 単一対象（v4） */
export interface OverlayRemoveEvent {
  type: 'OR';
  timestamp: string;
  sessionId: string;
  removeId: string;
  targetOverlayId: string;
}

export interface OverlayTransformEvent {
  type: 'OT';
  timestamp: string;
  sessionId: string;
  id: string;
  overlayId: string;
  dx?: number;
  dy?: number;
  dWidth?: number;
  dHeight?: number;
  dRotation?: number;
}

export interface ViewportDelta {
  dx?: number;
  dy?: number;
  dWidth?: number;
  dHeight?: number;
}

export interface OverlayViewportEvent {
  type: 'OV';
  timestamp: string;
  sessionId: string;
  id: string;
  overlayId: string;
  dViewport?: ViewportDelta;
  dPage?: number;
}

/** Overlay Style — 単一ターゲット（v4） */
export interface OverlayStyleEvent {
  type: 'OS';
  timestamp: string;
  sessionId: string;
  id: string;
  overlayId: string;
  dzIndex?: number;
  dOpacity?: number;
}

// ========================================
// 背景設定イベント（§3-6）
// ========================================

export type BgPattern = 'none' | 'dots' | 'grid' | 'lines';

export interface BackgroundEvent {
  type: 'BG';
  timestamp: string;
  sessionId: string;
  id: string;
  dColor?: ColorDelta;
  pattern?: EnumDelta<BgPattern>;
  dPatternSize?: number;
  dPatternColor?: ColorDelta;
}

// ========================================
// Canvas Size イベント（§3-7）
// ========================================

export interface CanvasSizeEvent {
  type: 'CS';
  timestamp: string;
  sessionId: string;
  id: string;
  dCanvasWidth?: number;
  dCanvasHeight?: number;
}

// ========================================
// BATCH イベント（§2-4 アトミックグループ）
// ========================================

/**
 * BATCH 内に格納できるサブイベント型。
 * SnapshotMarkerEvent と BatchEvent 自身は含まない。
 */
export type SubEvent =
  | DrawEvent
  | EraseEvent
  | OverlayAddEvent
  | OverlayRemoveEvent
  | OverlayTransformEvent
  | OverlayViewportEvent
  | OverlayStyleEvent
  | BackgroundEvent
  | CanvasSizeEvent;

/**
 * BATCH イベント — 複数のサブイベントをアトミックな1操作として記録する。
 *
 * 正規形ルール:
 * - サブイベントは2つ以上（MUST）
 * - 単一操作は BATCH で包まない（MUST）
 * - ネスト禁止（MUST）
 *
 * サブイベントの timestamp / sessionId は BATCH のものを継承する。
 * ファイルフォーマット上、サブイベントからは省略される。
 * メモリ上では BATCH の値で hydrate された状態で保持する。
 */
export interface BatchEvent {
  type: 'BATCH';
  id: string;
  timestamp: string;
  sessionId: string;
  events: SubEvent[];
}

// ========================================
// イベント統合型
// ========================================

export type OverlayEvent =
  | OverlayAddEvent
  | OverlayRemoveEvent
  | OverlayTransformEvent
  | OverlayViewportEvent
  | OverlayStyleEvent;

/** wbelx のトップレベルイベント */
export type WbelxEvent =
  | SubEvent
  | SnapshotMarkerEvent
  | BatchEvent;

// ========================================
// オーバーレイ状態
// ========================================

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
// 背景状態（§4-2）
// ========================================

export interface BackgroundState {
  color: { r: number; g: number; b: number } | null;
  pattern: BgPattern | null;
  patternSize: number | null;
  patternColor: { r: number; g: number; b: number } | null;
}

export const BG_SPEC_DEFAULTS = {
  color: { r: 255, g: 255, b: 255 },
  pattern: 'none' as BgPattern,
  patternSize: 20,
  patternColor: { r: 224, g: 224, b: 224 },
} as const;

// ========================================
// Undo/Redo 操作記録
// ========================================

export interface OverlayAddOperation {
  type: 'overlayAdd';
  overlayId: string;
  overlayData: OverlayAddEvent;
}

export interface OverlayRemoveOperation {
  type: 'overlayRemove';
  removeId: string;
  targetOverlayId: string;
  targetOverlay: OverlayAddEvent;
}

export interface OverlayTransformOperation {
  type: 'overlayTransform';
  id: string;
  overlayId: string;
  dx: number;
  dy: number;
  dWidth: number;
  dHeight: number;
  dRotation: number;
}

export interface OverlayViewportOperation {
  type: 'overlayViewport';
  id: string;
  overlayId: string;
  dViewport?: ViewportDelta;
  dPage?: number;
}

/** OS Undo: 単一ターゲット（v4） */
export interface OverlayStyleOperation {
  type: 'overlayStyle';
  id: string;
  overlayId: string;
  dzIndex?: number;
  dOpacity?: number;
}

export interface BackgroundOperation {
  type: 'background';
  id: string;
  dColor?: ColorDelta;
  pattern?: EnumDelta<BgPattern>;
  dPatternSize?: number;
  dPatternColor?: ColorDelta;
}

export interface CanvasSizeOperation {
  type: 'canvasSize';
  id: string;
  dCanvasWidth?: number;
  dCanvasHeight?: number;
}

/** 単一操作（BATCH のサブ操作としても使用） */
export type SingleOperation =
  | StrokeOperation
  | OverlayAddOperation
  | OverlayRemoveOperation
  | OverlayTransformOperation
  | OverlayViewportOperation
  | OverlayStyleOperation
  | BackgroundOperation
  | CanvasSizeOperation;

/** BATCH 操作記録 — Undo 時は operations を逆順に反転する */
export interface BatchOperation {
  type: 'batch';
  batchId: string;
  operations: SingleOperation[];
}

/** 全操作記録 = 1 Undo 単位 */
export type Operation = SingleOperation | BatchOperation;

// ========================================
// 拡張ホワイトボード状態
// ========================================

export interface WbelxState {
  activeStrokeIds: Set<string>;
  strokes: Map<string, DrawEvent>;
  activeOverlayIds: Set<string>;
  overlays: Map<string, OverlayState>;
  background: BackgroundState | null;
  canvasWidth: number;
  canvasHeight: number;
}

// ========================================
// 型ガード
// ========================================

export function isOverlayEvent(event: WbelxEvent): event is OverlayEvent {
  return event.type === 'OA' || event.type === 'OR' || event.type === 'OT' || event.type === 'OV' || event.type === 'OS';
}

export function isStrokeEvent(event: WbelxEvent): event is DrawEvent | EraseEvent {
  return event.type === 'D' || event.type === 'E';
}

export function isSnapshotEvent(event: WbelxEvent): event is SnapshotMarkerEvent {
  return event.type === 'S';
}

export function isBackgroundEvent(event: WbelxEvent): event is BackgroundEvent {
  return event.type === 'BG';
}

export function isCanvasSizeEvent(event: WbelxEvent): event is CanvasSizeEvent {
  return event.type === 'CS';
}

export function isBatchEvent(event: WbelxEvent): event is BatchEvent {
  return event.type === 'BATCH';
}

export function isSubEvent(event: WbelxEvent): event is SubEvent {
  return event.type !== 'BATCH' && event.type !== 'S';
}

// ========================================
// 投げ縄選択情報
// ========================================

/** 投げ縄で選択されたストローク ID とオーバーレイ ID */
export interface LassoSelection {
  strokeIds: Set<string>;
  overlayIds: Set<string>;
}

/** 投げ縄クリップボード（コピー / 貼り付け用） */
export interface LassoClipboard {
  strokes: DrawEvent[];
  overlays: OverlayState[];
  /** 元の BBox (canvas 座標) [minX, minY, maxX, maxY] */
  canvasBBox: [number, number, number, number];
}