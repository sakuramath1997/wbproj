/**
 * Core 層の型定義エントリポイント
 *
 * L1/L2 ロジックが参照する型のみを集約する。
 * ブラウザ API / React への依存は一切含まない。
 *
 * NOTE: 型定義の実体は types/ に残す（Shell 層・UI 層との共有のため）。
 * Core 層のモジュールは `../core/types` 経由で import する。
 */

// ---- wbel v8 ----
export type {
  Point,
  InputPoint,
  BBox,
  DrawEvent,
  EraseEvent,
  SnapshotMarkerEvent,
  DrawOperation,
  EraseOperation,
  StrokeOperation,
  WhiteboardState,
  CursorInfo,
  ToolType,
  StrokeWidthKey,
  CanvasTransform,
} from '../types/wbel';

// ---- wbelx v4 ----
export type {
  WbelxHeaderEvent,
  SnapshotHeaderEvent,
  Viewport,
  ColorDelta,
  EnumDelta,
  OverlayAddEvent,
  OverlayRemoveEvent,
  OverlayTransformEvent,
  ViewportDelta,
  OverlayViewportEvent,
  OverlayStyleEvent,
  BackgroundEvent,
  CanvasSizeEvent,
  SubEvent,
  BatchEvent,
  OverlayEvent,
  WbelxEvent,
  OverlayState,
  BackgroundState,
  OverlayAddOperation,
  OverlayRemoveOperation,
  OverlayTransformOperation,
  OverlayViewportOperation,
  OverlayStyleOperation,
  BackgroundOperation,
  CanvasSizeOperation,
  SingleOperation,
  BatchOperation,
  Operation,
  WbelxState,
  LassoSelection,
  LassoClipboard,
} from '../types/wbelx';

export type { BgPattern } from '../types/wbelx';

export {
  BG_SPEC_DEFAULTS,
  isOverlayEvent,
  isStrokeEvent,
  isSnapshotEvent,
  isBackgroundEvent,
  isCanvasSizeEvent,
  isBatchEvent,
  isSubEvent,
} from '../types/wbelx';

// ---- project (BackgroundConfig のみ — Core 層で BG デルタ計算に使用) ----
export type { BackgroundConfig, BackgroundPattern } from '../types/project';
export { DEFAULT_BACKGROUND } from '../types/project';