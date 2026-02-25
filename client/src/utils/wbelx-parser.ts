/**
 * wbelx パーサー・シリアライザー v4
 *
 * v4 変更点:
 * - BATCH イベントの読み書き（サブイベントの timestamp/sessionId hydrate/dehydrate）
 * - E.targetId 単一対象
 * - OR.targetOverlayId 単一対象
 * - OS 単一ターゲット
 * - CSV 後方互換は旧形式（targetIds 等）から v4 への変換を含む
 */

import type {
  DrawEvent,
  EraseEvent,
  SnapshotMarkerEvent,
  WbelxHeaderEvent,
  OverlayAddEvent,
  OverlayRemoveEvent,
  BatchEvent,
  WbelxEvent,
  SubEvent,
  SnapshotHeaderEvent,
  Viewport,
  BackgroundState,
} from '../types';
import { backgroundStateToSnapshotBGEvent } from '../core/state-machine';
import { eventToJsonl } from '../core/serializer';

// Re-export for backward compatibility
export { eventToJsonl } from '../core/serializer';

// ========================================
// ホワイトリスト
// ========================================

const KNOWN_SUB_TYPES = new Set(['D', 'E', 'OA', 'OR', 'OT', 'OV', 'OS', 'BG', 'CS']);

// ========================================
// JSONL パース
// ========================================

function parseJsonLine(line: string): WbelxEvent | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('//')) return null;

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const type = obj.type as string;
  if (type === 'H' || type === 'SS') return null;

  try {
    if (type === 'BATCH') {
      return hydrateBatch(obj);
    }
    if (KNOWN_SUB_TYPES.has(type)) {
      return obj as unknown as SubEvent;
    }
    console.warn(`Unknown event type: ${type}`);
    return null;
  } catch (e) {
    console.warn(`Failed to parse JSONL line: ${trimmed}`, e);
    return null;
  }
}

/**
 * BATCH の JSON オブジェクトをパースし、サブイベントに timestamp/sessionId を hydrate する。
 */
function hydrateBatch(obj: Record<string, unknown>): BatchEvent | null {
  const events = obj.events as Record<string, unknown>[];
  if (!Array.isArray(events) || events.length < 2) {
    console.warn('BATCH must contain at least 2 sub-events');
    return null;
  }

  const timestamp = obj.timestamp as string;
  const sessionId = obj.sessionId as string;

  const hydrated: SubEvent[] = [];
  for (const sub of events) {
    const subType = sub.type as string;
    if (!KNOWN_SUB_TYPES.has(subType)) {
      console.warn(`Unknown sub-event type in BATCH: ${subType}`);
      continue;
    }
    // hydrate: サブイベントに BATCH の timestamp/sessionId を注入
    hydrated.push({
      ...sub,
      timestamp,
      sessionId,
    } as unknown as SubEvent);
  }

  if (hydrated.length < 2) return null;

  return {
    type: 'BATCH',
    id: obj.id as string,
    timestamp,
    sessionId,
    events: hydrated,
  };
}

// ========================================
// CSV 後方互換パース（v5/v1）
// ========================================

function parseViewportString(str: string): Viewport {
  const [x, y, width, height] = str.split(';').map(Number);
  return { x, y, width, height };
}

/**
 * CSV の旧形式 E（targetIds: "s:001;s:002"）を v4 形式に変換する。
 * 複数対象の場合は BATCH に変換する。
 */
function parseCsvLine(line: string): WbelxEvent | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  const parts = trimmed.split(',');
  if (parts.length < 2) return null;

  const type = parts[0];
  try {
    switch (type) {
      case 'D': {
        const path = parts.slice(10).join(',');
        return {
          type: 'D',
          timestamp: parts[1],
          sessionId: parts[2],
          id: parts[3],
          color: parts[4],
          width: parseFloat(parts[5]),
          bbox: [
            parseInt(parts[6], 10),
            parseInt(parts[7], 10),
            parseInt(parts[8], 10),
            parseInt(parts[9], 10),
          ],
          path,
        } as DrawEvent;
      }
      case 'E': {
        const ids = parts[4].split(';').filter(Boolean);
        const timestamp = parts[1];
        const sessionId = parts[2];
        const baseId = parts[3];
        if (ids.length === 1) {
          return {
            type: 'E',
            timestamp,
            sessionId,
            id: baseId,
            targetId: ids[0],
          } as EraseEvent;
        }
        // 複数対象 → BATCH に変換
        return {
          type: 'BATCH',
          id: `b:migrated_${baseId}`,
          timestamp,
          sessionId,
          events: ids.map((targetId, i) => ({
            type: 'E' as const,
            timestamp,
            sessionId,
            id: i === 0 ? baseId : `${baseId}_${i}`,
            targetId,
          })),
        } as BatchEvent;
      }
      case 'S':
        return {
          type: 'S',
          timestamp: parts[1],
          sessionId: parts[2],
          snapshotHash: parts[3],
        } as SnapshotMarkerEvent;
      case 'OA':
        return {
          type: 'OA',
          timestamp: parts[1],
          sessionId: parts[2],
          overlayId: parts[3],
          assetUuid: parts[4],
          x: parseFloat(parts[5]),
          y: parseFloat(parts[6]),
          width: parseFloat(parts[7]),
          height: parseFloat(parts[8]),
          rotation: parseFloat(parts[9]),
          viewport: parseViewportString(parts[10]),
          page: parseInt(parts[11], 10),
          zIndex: parseInt(parts[12], 10),
          opacity: parseFloat(parts[13]),
        } as OverlayAddEvent;
      case 'OR': {
        const ids = parts[4].split(';').filter(Boolean);
        const timestamp = parts[1];
        const sessionId = parts[2];
        const baseId = parts[3];
        if (ids.length === 1) {
          return {
            type: 'OR',
            timestamp,
            sessionId,
            removeId: baseId,
            targetOverlayId: ids[0],
          } as OverlayRemoveEvent;
        }
        return {
          type: 'BATCH',
          id: `b:migrated_${baseId}`,
          timestamp,
          sessionId,
          events: ids.map((targetOverlayId, i) => ({
            type: 'OR' as const,
            timestamp,
            sessionId,
            removeId: i === 0 ? baseId : `${baseId}_${i}`,
            targetOverlayId,
          })),
        } as BatchEvent;
      }
      default:
        return null;
    }
  } catch (e) {
    console.warn(`Failed to parse CSV line: ${line}`, e);
    return null;
  }
}

// ========================================
// ファイル全体パース
// ========================================

export function parseWbelx(content: string): WbelxEvent[] {
  return parseWbelxWithHeader(content).events;
}

export interface ParsedWbelx {
  header: WbelxHeaderEvent | null;
  snapshotHeader: SnapshotHeaderEvent | null;
  events: WbelxEvent[];
}

export function parseWbelxWithHeader(content: string): ParsedWbelx {
  const lines = content.split('\n');
  const events: WbelxEvent[] = [];
  let header: WbelxHeaderEvent | null = null;
  let snapshotHeader: SnapshotHeaderEvent | null = null;

  const firstLine = lines.find(l => l.trim() && !l.trim().startsWith('#') && !l.trim().startsWith('//'));
  const isJsonl = firstLine?.trim().startsWith('{') ?? false;

  for (const line of lines) {
    if (isJsonl) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//')) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj.type === 'H' && !header) {
          header = {
            type: 'H',
            version: obj.version ?? 1,
            createdAt: obj.createdAt ?? '',
            canvasWidth: obj.canvasWidth ?? 0,
            canvasHeight: obj.canvasHeight ?? 0,
          };
          continue;
        }
        if (obj.type === 'SS' && !snapshotHeader) {
          snapshotHeader = { type: 'SS', version: obj.version ?? 1, hash: obj.hash ?? '', createdAt: obj.createdAt ?? '' };
          continue;
        }
      } catch { continue; }
    }
    const event = isJsonl ? parseJsonLine(line) : parseCsvLine(line);
    if (event) events.push(event);
  }

  return { header, snapshotHeader, events };
}

// ========================================
// シリアライズ（v4 JSONL）— eventToJsonl は core/serializer.ts に移動
// ========================================

export function eventsToWbelx(events: WbelxEvent[], canvasWidth = 0, canvasHeight = 0): string {
  const header: WbelxHeaderEvent = {
    type: 'H',
    version: 4,
    createdAt: new Date().toISOString(),
    canvasWidth,
    canvasHeight,
  };
  const lines = [JSON.stringify(header), ...events.map(eventToJsonl)];
  return lines.join('\n');
}

// ========================================
// スナップショット
// ========================================

export function parseSnapshot(content: string): { hash: string; events: WbelxEvent[] } | null {
  const firstLine = content.split('\n')[0]?.trim();
  if (firstLine?.startsWith('#SNAPSHOT,')) {
    const hash = firstLine.slice('#SNAPSHOT,'.length);
    const events = parseWbelx(content.split('\n').slice(1).join('\n'));
    return { hash, events };
  }

  const parsed = parseWbelxWithHeader(content);
  if (parsed.snapshotHeader) {
    return { hash: parsed.snapshotHeader.hash, events: parsed.events };
  }

  return null;
}

export function createSnapshot(
  events: WbelxEvent[],
  hash: string,
  background?: BackgroundState | null
): string {
  const header = JSON.stringify({ type: 'SS', version: 4, hash, createdAt: new Date().toISOString() });
  const lines = [header];
  for (const event of events) {
    if (event.type === 'D' || event.type === 'OA') {
      lines.push(eventToJsonl(event));
    }
  }

  if (background) {
    const bgSnap = backgroundStateToSnapshotBGEvent(
      background, new Date().toISOString(), '__snapshot__', 'bg:snapshot'
    );
    if (bgSnap) lines.push(eventToJsonl(bgSnap));
  }

  return lines.join('\n');
}
