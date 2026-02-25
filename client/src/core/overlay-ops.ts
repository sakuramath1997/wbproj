/**
 * core/overlay-ops.ts — オーバーレイ操作（Rust 移植対象）
 *
 * React 非依存。ブラウザ API 非依存。
 *
 * 移動元: BoardEditor.tsx 内の z-index 操作（993–1039行）、handleApplyViewport のビューポート再計算
 *
 * 参照仕様:
 *   wbelx-spec v4 §5-2 (OS イベント):
 *     dzIndex はデルタ（差分）であり、targets 配列でターゲットを指定する。
 *     z-index の入れ替えには 2 つの OS サブイベントを BATCH にまとめる。
 */

import type {
  OverlayState,
  OverlayStyleEvent,
  SubEvent,
  SingleOperation,
} from './types';

// ========================================
// z-index 操作用データ構造
// ========================================

export interface StyleTarget {
  overlayId: string;
  before: { zIndex: number; opacity: number };
  after: { zIndex: number; opacity: number };
}

export interface StyleDelta {
  overlayId: string;
  dzIndex?: number;
  dOpacity?: number;
}

// ========================================
// z-index 操作の BATCH/OS データ生成
// ========================================

/**
 * 「最前面へ」操作のスタイルターゲットを計算する。
 * 変更がない場合は null を返す。
 */
export function computeBringToFront(
  overlay: OverlayState,
  allOverlays: ReadonlyArray<OverlayState>,
): StyleTarget[] | null {
  const maxZ = Math.max(...allOverlays.map(o => o.zIndex));
  if (overlay.zIndex >= maxZ) return null;
  return [{
    overlayId: overlay.overlayId,
    before: { zIndex: overlay.zIndex, opacity: overlay.opacity },
    after: { zIndex: maxZ + 1, opacity: overlay.opacity },
  }];
}

/**
 * 「ひとつ前面へ」操作のスタイルターゲットを計算する（スワップ）。
 * 変更がない場合は null を返す。
 */
export function computeBringForward(
  overlay: OverlayState,
  allOverlays: ReadonlyArray<OverlayState>,
): StyleTarget[] | null {
  const sorted = [...allOverlays].sort((a, b) => a.zIndex - b.zIndex);
  const idx = sorted.findIndex(o => o.overlayId === overlay.overlayId);
  if (idx < 0 || idx >= sorted.length - 1) return null;
  const above = sorted[idx + 1];
  return [
    {
      overlayId: overlay.overlayId,
      before: { zIndex: overlay.zIndex, opacity: overlay.opacity },
      after: { zIndex: above.zIndex, opacity: overlay.opacity },
    },
    {
      overlayId: above.overlayId,
      before: { zIndex: above.zIndex, opacity: above.opacity },
      after: { zIndex: overlay.zIndex, opacity: above.opacity },
    },
  ];
}

/**
 * 「ひとつ背面へ」操作のスタイルターゲットを計算する（スワップ）。
 */
export function computeSendBackward(
  overlay: OverlayState,
  allOverlays: ReadonlyArray<OverlayState>,
): StyleTarget[] | null {
  const sorted = [...allOverlays].sort((a, b) => a.zIndex - b.zIndex);
  const idx = sorted.findIndex(o => o.overlayId === overlay.overlayId);
  if (idx <= 0) return null;
  const below = sorted[idx - 1];
  return [
    {
      overlayId: overlay.overlayId,
      before: { zIndex: overlay.zIndex, opacity: overlay.opacity },
      after: { zIndex: below.zIndex, opacity: overlay.opacity },
    },
    {
      overlayId: below.overlayId,
      before: { zIndex: below.zIndex, opacity: below.opacity },
      after: { zIndex: overlay.zIndex, opacity: below.opacity },
    },
  ];
}

/**
 * 「最背面へ」操作のスタイルターゲットを計算する。
 */
export function computeSendToBack(
  overlay: OverlayState,
  allOverlays: ReadonlyArray<OverlayState>,
): StyleTarget[] | null {
  const minZ = Math.min(...allOverlays.map(o => o.zIndex));
  if (overlay.zIndex <= minZ) return null;
  return [{
    overlayId: overlay.overlayId,
    before: { zIndex: overlay.zIndex, opacity: overlay.opacity },
    after: { zIndex: minZ - 1, opacity: overlay.opacity },
  }];
}

/**
 * StyleTarget 配列から OS サブイベント + SingleOperation ペアを生成する。
 */
export function buildStyleSubEvents(
  targets: StyleTarget[],
  timestamp: string,
  sessionId: string,
  generateStyleOpId: () => string,
): { subEvents: SubEvent[]; ops: SingleOperation[] } {
  const subEvents: SubEvent[] = [];
  const ops: SingleOperation[] = [];

  for (const t of targets) {
    const dzIndex = t.after.zIndex - t.before.zIndex;
    const dOpacity = t.after.opacity - t.before.opacity;
    const opId = generateStyleOpId();
    const sub: OverlayStyleEvent = {
      type: 'OS', timestamp, sessionId, id: opId, overlayId: t.overlayId,
      ...(dzIndex !== 0 && { dzIndex }),
      ...(Math.abs(dOpacity) > 1e-9 && { dOpacity }),
    };
    subEvents.push(sub);
    ops.push({
      type: 'overlayStyle', id: opId, overlayId: t.overlayId,
      ...(dzIndex !== 0 && { dzIndex }),
      ...(Math.abs(dOpacity) > 1e-9 && { dOpacity }),
    });
  }

  return { subEvents, ops };
}

// ========================================
// オーバーレイのソート
// ========================================

/** オーバーレイを z-index 昇順でソートする */
export function sortOverlaysByZIndex(overlays: ReadonlyArray<OverlayState>): OverlayState[] {
  return [...overlays].sort((a, b) => a.zIndex - b.zIndex);
}

// ========================================
// ビューポート適用時のオーバーレイ位置再計算
// ========================================

/**
 * ボードオーバーレイの viewport 変更時に、仮想全体表示を保持する
 * overlay 位置・サイズを再計算する。
 *
 * @param overlay 現在のオーバーレイ状態
 * @param vpOld 旧 viewport (initialBoardViewport or overlay.viewport)
 * @param vpNew 新 viewport
 * @returns 新しい { x, y, width, height } または変化なし時 null
 */
export function computeBoardViewportTransform(
  overlay: { x: number; y: number; width: number; height: number },
  vpOld: { x: number; y: number; width: number; height: number },
  vpNew: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } | null {
  // 仮想全体表示のスケール（ボード座標 1 単位 = WB 上の何 px か）
  const sx = overlay.width / vpOld.width;
  const sy = overlay.height / vpOld.height;

  // 仮想全体表示の WB 上の原点
  const tx = overlay.x - vpOld.x * sx;
  const ty = overlay.y - vpOld.y * sy;

  // 新しい viewport を適用した overlay の WB 座標
  const newX = tx + vpNew.x * sx;
  const newY = ty + vpNew.y * sy;
  const newW = vpNew.width * sx;
  const newH = vpNew.height * sy;

  // 変化がない場合は null
  const unchanged =
    Math.abs(newX - overlay.x) < 0.5 &&
    Math.abs(newY - overlay.y) < 0.5 &&
    Math.abs(newW - overlay.width) < 0.5 &&
    Math.abs(newH - overlay.height) < 0.5;

  if (unchanged) return null;

  return {
    x: Math.round(newX),
    y: Math.round(newY),
    width: Math.max(1, Math.round(newW)),
    height: Math.max(1, Math.round(newH)),
  };
}