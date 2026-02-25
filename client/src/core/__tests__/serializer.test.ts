/**
 * core/__tests__/serializer.test.ts
 *
 * core/serializer.ts のテスト。
 * eventToJsonl / eventsToWbelxContent の単体テスト。
 */

import { describe, it, expect } from 'vitest';
import { eventToJsonl, eventsToWbelxContent } from '../serializer';
import type {
  DrawEvent,
  EraseEvent,
  BatchEvent,
  OverlayAddEvent,
  OverlayTransformEvent,
  BackgroundEvent,
  CanvasSizeEvent,
} from '../types';

// ========================================
// テストヘルパー
// ========================================

const ts = '2026-01-01T00:00:00.000Z';
const sid = 'user1';

function makeD(id: string): DrawEvent {
  return {
    type: 'D', timestamp: ts, sessionId: sid,
    id, color: '#000', width: 2,
    bbox: [0, 0, 100, 100], path: 'M 0 0 L 100 100',
  };
}

function makeE(id: string, targetId: string): EraseEvent {
  return { type: 'E', timestamp: ts, sessionId: sid, id, targetId };
}

function makeOA(overlayId: string): OverlayAddEvent {
  return {
    type: 'OA', timestamp: ts, sessionId: sid,
    overlayId, assetUuid: 'asset-001',
    x: 10, y: 20, width: 200, height: 150, rotation: 0,
    viewport: { x: 0, y: 0, width: 200, height: 150 },
    page: 1, zIndex: 1, opacity: 1.0,
  };
}

// ========================================
// eventToJsonl
// ========================================

describe('eventToJsonl', () => {
  it('serializes D event as JSON', () => {
    const d = makeD('s:001');
    const json = eventToJsonl(d);
    const parsed = JSON.parse(json);
    expect(parsed.type).toBe('D');
    expect(parsed.id).toBe('s:001');
    expect(parsed.path).toBe('M 0 0 L 100 100');
  });

  it('serializes E event as JSON', () => {
    const e = makeE('e:001', 's:001');
    const json = eventToJsonl(e);
    const parsed = JSON.parse(json);
    expect(parsed.type).toBe('E');
    expect(parsed.targetId).toBe('s:001');
  });

  it('serializes OA event as JSON', () => {
    const oa = makeOA('o:001');
    const json = eventToJsonl(oa);
    const parsed = JSON.parse(json);
    expect(parsed.type).toBe('OA');
    expect(parsed.viewport).toEqual({ x: 0, y: 0, width: 200, height: 150 });
  });

  it('dehydrates BATCH sub-events (removes timestamp/sessionId)', () => {
    const batch: BatchEvent = {
      type: 'BATCH', id: 'b:001', timestamp: ts, sessionId: sid,
      events: [
        makeD('s:001'),
        makeD('s:002'),
      ],
    };
    const json = eventToJsonl(batch);
    const parsed = JSON.parse(json);

    expect(parsed.type).toBe('BATCH');
    expect(parsed.id).toBe('b:001');
    expect(parsed.timestamp).toBe(ts);
    expect(parsed.sessionId).toBe(sid);
    // サブイベントには timestamp/sessionId がない
    for (const sub of parsed.events) {
      expect(sub).not.toHaveProperty('timestamp');
      expect(sub).not.toHaveProperty('sessionId');
    }
    // サブイベントの中身は保持される
    expect(parsed.events[0].id).toBe('s:001');
    expect(parsed.events[1].id).toBe('s:002');
  });

  it('BATCH with mixed sub-event types dehydrates all correctly', () => {
    const batch: BatchEvent = {
      type: 'BATCH', id: 'b:002', timestamp: ts, sessionId: sid,
      events: [
        makeE('e:001', 's:001'),
        makeE('e:002', 's:002'),
      ],
    };
    const json = eventToJsonl(batch);
    const parsed = JSON.parse(json);

    expect(parsed.events).toHaveLength(2);
    expect(parsed.events[0].type).toBe('E');
    expect(parsed.events[0].targetId).toBe('s:001');
    expect(parsed.events[1].targetId).toBe('s:002');
  });

  it('serializes OT delta event', () => {
    const ot: OverlayTransformEvent = {
      type: 'OT', timestamp: ts, sessionId: sid,
      id: 'ot:001', overlayId: 'o:001',
      dx: 50, dy: -30,
    };
    const json = eventToJsonl(ot);
    const parsed = JSON.parse(json);
    expect(parsed.dx).toBe(50);
    expect(parsed.dy).toBe(-30);
  });

  it('serializes BG delta event with color and pattern', () => {
    const bg: BackgroundEvent = {
      type: 'BG', timestamp: ts, sessionId: sid, id: 'bg:001',
      dColor: { space: 'srgb', dr: 10, dg: -5, db: 0 },
      pattern: { prev: 'none', next: 'grid' },
      dPatternSize: 5,
    };
    const json = eventToJsonl(bg);
    const parsed = JSON.parse(json);
    expect(parsed.dColor.dr).toBe(10);
    expect(parsed.pattern.prev).toBe('none');
    expect(parsed.pattern.next).toBe('grid');
  });

  it('serializes CS delta event', () => {
    const cs: CanvasSizeEvent = {
      type: 'CS', timestamp: ts, sessionId: sid, id: 'cs:001',
      dCanvasWidth: 1920, dCanvasHeight: 1080,
    };
    const json = eventToJsonl(cs);
    const parsed = JSON.parse(json);
    expect(parsed.dCanvasWidth).toBe(1920);
    expect(parsed.dCanvasHeight).toBe(1080);
  });
});

// ========================================
// eventsToWbelxContent
// ========================================

describe('eventsToWbelxContent', () => {
  it('produces valid JSONL with H header as first line', () => {
    const events = [makeD('s:001'), makeD('s:002')];
    const content = eventsToWbelxContent(events, ts, 1920, 1080);
    const lines = content.split('\n');

    expect(lines).toHaveLength(3); // header + 2 events

    const header = JSON.parse(lines[0]);
    expect(header.type).toBe('H');
    expect(header.version).toBe(4);
    expect(header.canvasWidth).toBe(1920);
    expect(header.canvasHeight).toBe(1080);
  });

  it('defaults canvasWidth/canvasHeight to 0', () => {
    const content = eventsToWbelxContent([], ts);
    const header = JSON.parse(content.split('\n')[0]);
    expect(header.canvasWidth).toBe(0);
    expect(header.canvasHeight).toBe(0);
  });

  it('empty events produces header-only content', () => {
    const content = eventsToWbelxContent([], ts);
    const lines = content.split('\n');
    expect(lines).toHaveLength(1);
  });

  it('BATCH events in content are dehydrated', () => {
    const batch: BatchEvent = {
      type: 'BATCH', id: 'b:001', timestamp: ts, sessionId: sid,
      events: [makeD('s:001'), makeD('s:002')],
    };
    const content = eventsToWbelxContent([batch], ts);
    const lines = content.split('\n');
    const parsedBatch = JSON.parse(lines[1]);
    expect(parsedBatch.events[0]).not.toHaveProperty('timestamp');
  });
});
