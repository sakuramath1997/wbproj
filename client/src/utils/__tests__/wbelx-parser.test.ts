import { describe, it, expect } from 'vitest';
import {
  parseWbelx,
  parseWbelxWithHeader,
  eventToJsonl,
  eventsToWbelx,
  parseSnapshot,
  createSnapshot,
} from '../wbelx-parser';
import type {
  DrawEvent,
  EraseEvent,
  BatchEvent,
  OverlayRemoveEvent,
  WbelxEvent,
} from '../../types';

// ========================================
// ヘルパー
// ========================================

function makeD(id: string): DrawEvent {
  return {
    type: 'D', timestamp: '2026-01-01T00:00:00.000Z', sessionId: 'sess1', id,
    color: '#000', width: 2, bbox: [0, 0, 10, 10], path: 'M 0 0 L 10 10',
  };
}

function makeE(id: string, targetId: string): EraseEvent {
  return { type: 'E', timestamp: '2026-01-01T00:00:00.000Z', sessionId: 'sess1', id, targetId };
}

// ========================================
// BATCH シリアライズ / デシリアライズ
// ========================================

describe('BATCH serialization', () => {
  it('eventToJsonl dehydrates sub-event timestamp/sessionId', () => {
    const batch: BatchEvent = {
      type: 'BATCH',
      id: 'b:test001',
      timestamp: '2026-01-01T00:00:00.000Z',
      sessionId: 'sess1',
      events: [
        makeE('e:001', 's:001'),
        makeE('e:002', 's:002'),
      ],
    };
    const jsonl = eventToJsonl(batch);
    const parsed = JSON.parse(jsonl);

    expect(parsed.type).toBe('BATCH');
    expect(parsed.id).toBe('b:test001');
    expect(parsed.timestamp).toBe('2026-01-01T00:00:00.000Z');
    expect(parsed.sessionId).toBe('sess1');
    expect(parsed.events).toHaveLength(2);

    // Sub-events should NOT have timestamp/sessionId
    for (const sub of parsed.events) {
      expect(sub.timestamp).toBeUndefined();
      expect(sub.sessionId).toBeUndefined();
      expect(sub.type).toBe('E');
    }
  });

  it('single events are serialized normally', () => {
    const d = makeD('s:001');
    const jsonl = eventToJsonl(d);
    const parsed = JSON.parse(jsonl);
    expect(parsed.type).toBe('D');
    expect(parsed.timestamp).toBe('2026-01-01T00:00:00.000Z');
    expect(parsed.sessionId).toBe('sess1');
  });
});

describe('BATCH deserialization', () => {
  it('parseWbelx hydrates sub-event timestamp/sessionId from BATCH', () => {
    const jsonl = JSON.stringify({
      type: 'BATCH', id: 'b:test001',
      timestamp: '2026-01-01T00:00:00.000Z', sessionId: 'sess1',
      events: [
        { type: 'E', id: 'e:001', targetId: 's:001' },
        { type: 'E', id: 'e:002', targetId: 's:002' },
      ],
    });
    const content = `{"type":"H","version":4,"createdAt":"2026-01-01","canvasWidth":0,"canvasHeight":0}\n${jsonl}`;
    const events = parseWbelx(content);
    expect(events).toHaveLength(1);

    const batch = events[0] as BatchEvent;
    expect(batch.type).toBe('BATCH');
    expect(batch.events).toHaveLength(2);

    // Sub-events should have hydrated timestamp/sessionId
    for (const sub of batch.events) {
      expect((sub as EraseEvent).timestamp).toBe('2026-01-01T00:00:00.000Z');
      expect((sub as EraseEvent).sessionId).toBe('sess1');
    }
  });

  it('rejects BATCH with fewer than 2 sub-events', () => {
    const jsonl = JSON.stringify({
      type: 'BATCH', id: 'b:bad',
      timestamp: '2026-01-01T00:00:00.000Z', sessionId: 'sess1',
      events: [{ type: 'E', id: 'e:001', targetId: 's:001' }],
    });
    const content = `{"type":"H","version":4,"createdAt":"2026-01-01","canvasWidth":0,"canvasHeight":0}\n${jsonl}`;
    const events = parseWbelx(content);
    expect(events).toHaveLength(0); // Invalid BATCH should be rejected
  });

  it('skips unknown sub-event types in BATCH', () => {
    const jsonl = JSON.stringify({
      type: 'BATCH', id: 'b:mixed',
      timestamp: '2026-01-01T00:00:00.000Z', sessionId: 'sess1',
      events: [
        { type: 'E', id: 'e:001', targetId: 's:001' },
        { type: 'UNKNOWN_FUTURE_TYPE', id: 'x:001' },
        { type: 'E', id: 'e:002', targetId: 's:002' },
      ],
    });
    const content = `{"type":"H","version":4,"createdAt":"2026-01-01","canvasWidth":0,"canvasHeight":0}\n${jsonl}`;
    const events = parseWbelx(content);
    expect(events).toHaveLength(1);
    const batch = events[0] as BatchEvent;
    // Unknown sub removed, but 2 valid remain
    expect(batch.events).toHaveLength(2);
  });
});

// ========================================
// BATCH ラウンドトリップ
// ========================================

describe('BATCH roundtrip (serialize → deserialize)', () => {
  it('cross-domain BATCH roundtrips correctly', () => {
    const original: BatchEvent = {
      type: 'BATCH',
      id: 'b:roundtrip',
      timestamp: '2026-02-22T12:00:00.000Z',
      sessionId: 'sess_rt',
      events: [
        { type: 'E', timestamp: '2026-02-22T12:00:00.000Z', sessionId: 'sess_rt', id: 'e:001', targetId: 's:001' },
        {
          type: 'D', timestamp: '2026-02-22T12:00:00.000Z', sessionId: 'sess_rt', id: 's:002',
          color: '#ff0000', width: 4, bbox: [10, 20, 30, 40], path: 'M 10 20 C 15 25 20 30 30 40',
        },
        {
          type: 'OT', timestamp: '2026-02-22T12:00:00.000Z', sessionId: 'sess_rt',
          id: 'ot:001', overlayId: 'o:001', dx: 50, dy: -30,
        },
      ],
    };

    const wbelx = eventsToWbelx([original]);
    const parsed = parseWbelx(wbelx);
    expect(parsed).toHaveLength(1);

    const result = parsed[0] as BatchEvent;
    expect(result.type).toBe('BATCH');
    expect(result.id).toBe('b:roundtrip');
    expect(result.timestamp).toBe('2026-02-22T12:00:00.000Z');
    expect(result.sessionId).toBe('sess_rt');
    expect(result.events).toHaveLength(3);

    // Verify each sub-event
    const [e, d, ot] = result.events;
    expect(e.type).toBe('E');
    expect((e as EraseEvent).targetId).toBe('s:001');
    expect(d.type).toBe('D');
    expect((d as DrawEvent).id).toBe('s:002');
    expect((d as DrawEvent).path).toBe('M 10 20 C 15 25 20 30 30 40');
    expect(ot.type).toBe('OT');
    expect((ot as any).dx).toBe(50);
    expect((ot as any).dy).toBe(-30);

    // All sub-events should have hydrated timestamp/sessionId
    for (const sub of result.events) {
      expect((sub as any).timestamp).toBe('2026-02-22T12:00:00.000Z');
      expect((sub as any).sessionId).toBe('sess_rt');
    }
  });
});

// ========================================
// CSV 後方互換（旧 targetIds → v4 BATCH マイグレーション）
// ========================================

describe('CSV backward compatibility', () => {
  it('single E.targetId from CSV parses as single E', () => {
    const csv = 'D,2026-01-01T00:00:00.000Z,sess1,s:001,#000,2,0,0,10,10,M 0 0\nE,2026-01-01T00:00:00.000Z,sess1,e:001,s:001';
    const events = parseWbelx(csv);
    expect(events).toHaveLength(2);
    expect(events[1].type).toBe('E');
    expect((events[1] as EraseEvent).targetId).toBe('s:001');
  });

  it('multiple E.targetIds from CSV parses as BATCH', () => {
    const csv = 'D,2026-01-01T00:00:00.000Z,sess1,s:001,#000,2,0,0,10,10,M 0 0\nD,2026-01-01T00:00:00.000Z,sess1,s:002,#000,2,0,0,10,10,M 0 0\nE,2026-01-01T00:00:00.000Z,sess1,e:001,s:001;s:002';
    const events = parseWbelx(csv);
    expect(events).toHaveLength(3); // D, D, BATCH

    const batch = events[2] as BatchEvent;
    expect(batch.type).toBe('BATCH');
    expect(batch.events).toHaveLength(2);
    expect((batch.events[0] as EraseEvent).targetId).toBe('s:001');
    expect((batch.events[1] as EraseEvent).targetId).toBe('s:002');
  });

  it('multiple OR.targetOverlayIds from CSV parses as BATCH', () => {
    const csv = 'OA,2026-01-01,sess1,o:001,asset1,0,0,100,100,0,0;0;100;100,1,1,1.0\nOA,2026-01-01,sess1,o:002,asset2,0,0,100,100,0,0;0;100;100,1,2,1.0\nOR,2026-01-01,sess1,r:001,o:001;o:002';
    const events = parseWbelx(csv);
    expect(events).toHaveLength(3); // OA, OA, BATCH

    const batch = events[2] as BatchEvent;
    expect(batch.type).toBe('BATCH');
    expect(batch.events).toHaveLength(2);
    expect((batch.events[0] as OverlayRemoveEvent).targetOverlayId).toBe('o:001');
    expect((batch.events[1] as OverlayRemoveEvent).targetOverlayId).toBe('o:002');
  });
});

// ========================================
// H ヘッダーパース
// ========================================

describe('H header', () => {
  it('parses v4 header with canvasWidth/canvasHeight', () => {
    const content = '{"type":"H","version":4,"createdAt":"2026-01-01","canvasWidth":1920,"canvasHeight":1080}\n{"type":"D","timestamp":"","sessionId":"","id":"s:001","color":"#000","width":2,"bbox":[0,0,10,10],"path":"M 0 0"}';
    const { header, events } = parseWbelxWithHeader(content);
    expect(header).not.toBeNull();
    expect(header!.version).toBe(4);
    expect(header!.canvasWidth).toBe(1920);
    expect(header!.canvasHeight).toBe(1080);
    expect(events).toHaveLength(1);
  });
});

// ========================================
// スナップショット
// ========================================

describe('snapshot', () => {
  it('creates and parses snapshot with SS header', () => {
    const events: WbelxEvent[] = [makeD('s:001'), makeD('s:002')];
    const bg = {
      color: { r: 100, g: 100, b: 100 },
      pattern: 'dots' as const,
      patternSize: 15,
      patternColor: { r: 200, g: 200, b: 200 },
    };
    const snapshot = createSnapshot(events, 'sha256:testhash', bg);
    const parsed = parseSnapshot(snapshot);

    expect(parsed).not.toBeNull();
    expect(parsed!.hash).toBe('sha256:testhash');
    expect(parsed!.events.length).toBeGreaterThanOrEqual(2); // D events + BG
  });
});
