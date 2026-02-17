/**
 * wbelx パーサー・シリアライザー
 * 
 * CSV 形式のイベントログを読み書き
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
} from '../types';
import { parseViewport, viewportToString } from '../types';

// ========================================
// パース
// ========================================

/**
 * 1行をパースしてイベントに変換
 */
export function parseLine(line: string): WbelxEvent | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }

  const parts = trimmed.split(',');
  if (parts.length < 2) {
    return null;
  }

  const type = parts[0];

  try {
    switch (type) {
      case 'D':
        return parseDrawEvent(parts);
      case 'E':
        return parseEraseEvent(parts);
      case 'S':
        return parseSnapshotEvent(parts);
      case 'OA':
        return parseOverlayAddEvent(parts);
      case 'OR':
        return parseOverlayRemoveEvent(parts);
      case 'OT':
        return parseOverlayTransformEvent(parts);
      case 'OV':
        return parseOverlayViewportEvent(parts);
      case 'OS':
        return parseOverlayStyleEvent(parts);
      default:
        console.warn(`Unknown event type: ${type}`);
        return null;
    }
  } catch (e) {
    console.warn(`Failed to parse line: ${line}`, e);
    return null;
  }
}

function parseDrawEvent(parts: string[]): DrawEvent {
  // D,timestamp,session_id,id,color,width,minX,minY,maxX,maxY,path...
  const path = parts.slice(10).join(','); // path 内にカンマが含まれる可能性
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
  };
}

function parseEraseEvent(parts: string[]): EraseEvent {
  // E,timestamp,session_id,id,target_ids
  return {
    type: 'E',
    timestamp: parts[1],
    sessionId: parts[2],
    id: parts[3],
    targetIds: parts[4].split(';').filter(Boolean),
  };
}

function parseSnapshotEvent(parts: string[]): SnapshotMarkerEvent {
  // S,timestamp,session_id,snapshot_hash
  return {
    type: 'S',
    timestamp: parts[1],
    sessionId: parts[2],
    snapshotHash: parts[3],
  };
}

function parseOverlayAddEvent(parts: string[]): OverlayAddEvent {
  // OA,timestamp,session_id,overlay_id,asset_uuid,x,y,width,height,rotation,viewport,page,z_index,opacity
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
    viewport: parseViewport(parts[10]),
    page: parseInt(parts[11], 10),
    zIndex: parseInt(parts[12], 10),
    opacity: parseFloat(parts[13]),
  };
}

function parseOverlayRemoveEvent(parts: string[]): OverlayRemoveEvent {
  // OR,timestamp,session_id,remove_id,target_overlay_ids
  return {
    type: 'OR',
    timestamp: parts[1],
    sessionId: parts[2],
    removeId: parts[3],
    targetOverlayIds: parts[4].split(';').filter(Boolean),
  };
}

function parseOverlayTransformEvent(parts: string[]): OverlayTransformEvent {
  // OT,timestamp,session_id,overlay_id,x,y,width,height,rotation
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
  };
}

function parseOverlayViewportEvent(parts: string[]): OverlayViewportEvent {
  // OV,timestamp,session_id,overlay_id,viewport,page
  return {
    type: 'OV',
    timestamp: parts[1],
    sessionId: parts[2],
    overlayId: parts[3],
    viewport: parseViewport(parts[4]),
    page: parseInt(parts[5], 10),
  };
}

function parseOverlayStyleEvent(parts: string[]): OverlayStyleEvent {
  // OS,timestamp,session_id,overlay_id,z_index,opacity
  return {
    type: 'OS',
    timestamp: parts[1],
    sessionId: parts[2],
    overlayId: parts[3],
    zIndex: parseInt(parts[4], 10),
    opacity: parseFloat(parts[5]),
  };
}

/**
 * wbelx ファイル全体をパース
 */
export function parseWbelx(content: string): WbelxEvent[] {
  const lines = content.split('\n');
  const events: WbelxEvent[] = [];

  for (const line of lines) {
    const event = parseLine(line);
    if (event) {
      events.push(event);
    }
  }

  return events;
}

// ========================================
// シリアライズ
// ========================================

/**
 * イベントを1行に変換
 */
export function eventToLine(event: WbelxEvent): string {
  switch (event.type) {
    case 'D':
      return drawEventToLine(event);
    case 'E':
      return eraseEventToLine(event);
    case 'S':
      return snapshotEventToLine(event);
    case 'OA':
      return overlayAddEventToLine(event);
    case 'OR':
      return overlayRemoveEventToLine(event);
    case 'OT':
      return overlayTransformEventToLine(event);
    case 'OV':
      return overlayViewportEventToLine(event);
    case 'OS':
      return overlayStyleEventToLine(event);
    default:
      throw new Error(`Unknown event type: ${(event as WbelxEvent).type}`);
  }
}

function drawEventToLine(event: DrawEvent): string {
  const { timestamp, sessionId, id, color, width, bbox, path } = event;
  return `D,${timestamp},${sessionId},${id},${color},${width},${bbox[0]},${bbox[1]},${bbox[2]},${bbox[3]},${path}`;
}

function eraseEventToLine(event: EraseEvent): string {
  const { timestamp, sessionId, id, targetIds } = event;
  return `E,${timestamp},${sessionId},${id},${targetIds.join(';')}`;
}

function snapshotEventToLine(event: SnapshotMarkerEvent): string {
  const { timestamp, sessionId, snapshotHash } = event;
  return `S,${timestamp},${sessionId},${snapshotHash}`;
}

function overlayAddEventToLine(event: OverlayAddEvent): string {
  const { timestamp, sessionId, overlayId, assetUuid, x, y, width, height, rotation, viewport, page, zIndex, opacity } = event;
  return `OA,${timestamp},${sessionId},${overlayId},${assetUuid},${x},${y},${width},${height},${rotation},${viewportToString(viewport)},${page},${zIndex},${opacity}`;
}

function overlayRemoveEventToLine(event: OverlayRemoveEvent): string {
  const { timestamp, sessionId, removeId, targetOverlayIds } = event;
  return `OR,${timestamp},${sessionId},${removeId},${targetOverlayIds.join(';')}`;
}

function overlayTransformEventToLine(event: OverlayTransformEvent): string {
  const { timestamp, sessionId, overlayId, x, y, width, height, rotation } = event;
  return `OT,${timestamp},${sessionId},${overlayId},${x},${y},${width},${height},${rotation}`;
}

function overlayViewportEventToLine(event: OverlayViewportEvent): string {
  const { timestamp, sessionId, overlayId, viewport, page } = event;
  return `OV,${timestamp},${sessionId},${overlayId},${viewportToString(viewport)},${page}`;
}

function overlayStyleEventToLine(event: OverlayStyleEvent): string {
  const { timestamp, sessionId, overlayId, zIndex, opacity } = event;
  return `OS,${timestamp},${sessionId},${overlayId},${zIndex},${opacity}`;
}

/**
 * イベント配列を wbelx 形式の文字列に変換
 */
export function eventsToWbelx(events: WbelxEvent[]): string {
  return events.map(eventToLine).join('\n');
}

// ========================================
// スナップショット
// ========================================

/**
 * スナップショットファイルをパース
 */
export function parseSnapshot(content: string): { hash: string; events: WbelxEvent[] } | null {
  const lines = content.split('\n');
  if (lines.length === 0) return null;

  const header = lines[0];
  if (!header.startsWith('#SNAPSHOT,')) return null;

  const hash = header.slice('#SNAPSHOT,'.length);
  const events = parseWbelx(lines.slice(1).join('\n'));

  return { hash, events };
}

/**
 * スナップショットファイルを生成
 */
export function createSnapshot(events: WbelxEvent[], hash: string): string {
  const lines = [`#SNAPSHOT,${hash}`];
  for (const event of events) {
    // スナップショットには D と OA のみ含める
    if (event.type === 'D' || event.type === 'OA') {
      lines.push(eventToLine(event));
    }
  }
  return lines.join('\n');
}
