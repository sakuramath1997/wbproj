/**
 * 共通ユーティリティ
 */

// ========================================
// ID 生成
// ========================================

/** ランダムな文字列を生成 */
function randomString(length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

/** ストローク ID を生成 (s:xxx) */
export function generateStrokeId(): string {
  return `s:${randomString(12)}`;
}

/** 消去操作 ID を生成 (e:xxx) */
export function generateEraseId(): string {
  return `e:${randomString(12)}`;
}

/** オーバーレイ ID を生成 (o:xxx) */
export function generateOverlayId(): string {
  return `o:${randomString(12)}`;
}

/** 削除操作 ID を生成 (r:xxx) */
export function generateRemoveId(): string {
  return `r:${randomString(12)}`;
}

/** ビューポート変更 ID を生成 (v:xxx) */
export function generateViewportId(): string {
  return `v:${randomString(12)}`;
}

/** UUID v4 を生成 */
export function generateUuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/** スナップショットハッシュを生成 */
export function generateSnapshotHash(): string {
  return Date.now().toString(36) + randomString(6);
}

/** スナップショット ID を生成（generateSnapshotHash のエイリアス） */
export const generateSnapshotId = generateSnapshotHash;

// ========================================
// タイムスタンプ
// ========================================

/** ISO 8601 タイムスタンプを取得 */
export function getTimestamp(): string {
  return new Date().toISOString();
}

// ========================================
// セッション ID
// ========================================

const SESSION_ID_KEY = 'whiteboard_session_id';

/** セッション ID のバリデーション */
export function isValidSessionId(id: string): boolean {
  if (id.length > 32) return false;
  return /^[a-zA-Z0-9_-]*$/.test(id);
}

/** セッション ID を取得または生成 */
export function getOrCreateSessionId(): string {
  try {
    const stored = localStorage.getItem(SESSION_ID_KEY);
    if (stored && isValidSessionId(stored)) {
      return stored;
    }
  } catch {
    // localStorage が使えない環境
  }

  const newId = randomString(16);

  try {
    localStorage.setItem(SESSION_ID_KEY, newId);
  } catch {
    // 保存失敗は無視
  }

  return newId;
}

// ========================================
// BBox 計算
// ========================================

import type { Point, BBox } from '../types';

/** 点の配列から BBox を計算 */
export function calculateBBox(points: Point[]): BBox {
  if (points.length === 0) {
    return [0, 0, 0, 0];
  }

  let minX = points[0].x;
  let minY = points[0].y;
  let maxX = points[0].x;
  let maxY = points[0].y;

  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }

  return [
    Math.floor(minX),
    Math.floor(minY),
    Math.ceil(maxX),
    Math.ceil(maxY),
  ];
}

/** 点が BBox 内にあるか判定（マージン付き） */
export function isPointInBBox(x: number, y: number, bbox: BBox, margin = 0): boolean {
  const [minX, minY, maxX, maxY] = bbox;
  return (
    x >= minX - margin &&
    x <= maxX + margin &&
    y >= minY - margin &&
    y <= maxY + margin
  );
}

// ========================================
// ファイル名
// ========================================

/** 次のボードファイル名を生成 (0001, 0002, ...) */
export function getNextBoardId(existingIds: string[]): string {
  if (existingIds.length === 0) {
    return '0001';
  }

  const maxNum = Math.max(...existingIds.map(id => parseInt(id, 10) || 0));
  return String(maxNum + 1).padStart(4, '0');
}
