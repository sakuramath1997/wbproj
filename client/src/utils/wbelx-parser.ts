/**
 * wbelx パーサー・シリアライザー
 *
 * v6/v2 JSONL 形式の読み書き。
 * v5/v1 CSV 形式の後方互換読み込みもサポート。
 */

import type {
  DrawEvent,
  EraseEvent,
  SnapshotMarkerEvent,
  OverlayAddEvent,
  OverlayRemoveEvent,
  OverlayTransformEvent,
  OverlayViewportEvent,
  OverlayStyleEvent,
  WbelxEvent,
  Viewport,
} from '../types';

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
  if (type === 'H' || type === 'SS') return null; // ヘッダー行は無視

  try {
    switch (type) {
      case 'D': return obj as unknown as DrawEvent;
      case 'E': return obj as unknown as EraseEvent;
      case 'S': return obj as unknown as SnapshotMarkerEvent;
      case 'OA': return obj as unknown as OverlayAddEvent;
      case 'OR': return obj as unknown as OverlayRemoveEvent;
      case 'OT': return obj as unknown as OverlayTransformEvent;
      case 'OV': return obj as unknown as OverlayViewportEvent;
      case 'OS': return obj as unknown as OverlayStyleEvent;
      default:
        console.warn(`Unknown event type: ${type}`);
        return null;
    }
  } catch (e) {
    console.warn(`Failed to parse JSONL line: ${trimmed}`, e);
    return null;
  }
}

// ========================================
// CSV 後方互換パース（v5/v1）
// ========================================

function parseViewportString(str: string): Viewport {
  const [x, y, width, height] = str.split(';').map(Number);
  return { x, y, width, height };
}

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
      case 'E':
        return {
          type: 'E',
          timestamp: parts[1],
          sessionId: parts[2],
          id: parts[3],
          targetIds: parts[4].split(';').filter(Boolean),
        } as EraseEvent;
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
      case 'OR':
        return {
          type: 'OR',
          timestamp: parts[1],
          sessionId: parts[2],
          removeId: parts[3],
          targetOverlayIds: parts[4].split(';').filter(Boolean),
        } as OverlayRemoveEvent;
      case 'OT':
        return {
          type: 'OT',
          timestamp: parts[1],
          sessionId: parts[2],
          overlayId: parts[3],
          x: parseFloat(parts[4]),
          y: parseFloat(parts[5]),
          width: parseFloat(parts[6]),
          height: parseFloat(parts[7]),
          rotation: parseFloat(parts[8]),
        } as OverlayTransformEvent;
      case 'OV':
        return {
          type: 'OV',
          timestamp: parts[1],
          sessionId: parts[2],
          overlayId: parts[3],
          viewport: parseViewportString(parts[4]),
          page: parseInt(parts[5], 10),
        } as OverlayViewportEvent;
      case 'OS':
        // v1 CSV: 単一ターゲット → v2 形式に変換
        return {
          type: 'OS',
          timestamp: parts[1],
          sessionId: parts[2],
          targets: [{
            overlayId: parts[3],
            zIndex: parseInt(parts[4], 10),
            opacity: parseFloat(parts[5]),
          }],
        } as OverlayStyleEvent;
      default:
        console.warn(`Unknown CSV event type: ${type}`);
        return null;
    }
  } catch (e) {
    console.warn(`Failed to parse CSV line: ${line}`, e);
    return null;
  }
}

// ========================================
// ファイル全体パース（v5/v6 自動判別）
// ========================================

export function parseWbelx(content: string): WbelxEvent[] {
  const lines = content.split('\n');
  const events: WbelxEvent[] = [];

  // 先頭の有効行を見てフォーマット判別
  const firstLine = lines.find(l => l.trim() && !l.trim().startsWith('#') && !l.trim().startsWith('//'));
  const isJsonl = firstLine?.trim().startsWith('{') ?? false;

  for (const line of lines) {
    const event = isJsonl ? parseJsonLine(line) : parseCsvLine(line);
    if (event) events.push(event);
  }

  return events;
}

// ========================================
// シリアライズ（v2 JSONL）
// ========================================

export function eventToJsonl(event: WbelxEvent): string {
  return JSON.stringify(event);
}

export function eventsToWbelx(events: WbelxEvent[]): string {
  const header = JSON.stringify({ type: 'H', version: 2, createdAt: new Date().toISOString() });
  const lines = [header, ...events.map(eventToJsonl)];
  return lines.join('\n');
}

// ========================================
// スナップショット
// ========================================

export function parseSnapshot(content: string): { hash: string; events: WbelxEvent[] } | null {
  const lines = content.split('\n');
  if (lines.length === 0) return null;

  const firstLine = lines[0].trim();

  // v2 JSONL スナップショット
  if (firstLine.startsWith('{')) {
    try {
      const header = JSON.parse(firstLine) as { type: string; hash: string };
      if (header.type !== 'SS' || !header.hash) return null;
      const eventsContent = lines.slice(1).join('\n');
      return { hash: header.hash, events: parseWbelx(eventsContent) };
    } catch {
      return null;
    }
  }

  // v1 CSV スナップショット（後方互換）
  if (firstLine.startsWith('#SNAPSHOT,')) {
    const hash = firstLine.slice('#SNAPSHOT,'.length);
    const events = parseWbelx(lines.slice(1).join('\n'));
    return { hash, events };
  }

  return null;
}

export function createSnapshot(events: WbelxEvent[], hash: string): string {
  const header = JSON.stringify({ type: 'SS', version: 2, hash, createdAt: new Date().toISOString() });
  const lines = [header];
  for (const event of events) {
    if (event.type === 'D' || event.type === 'OA') {
      lines.push(eventToJsonl(event));
    }
  }
  return lines.join('\n');
}
