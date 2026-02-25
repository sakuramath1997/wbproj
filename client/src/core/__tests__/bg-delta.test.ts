import { describe, it, expect } from 'vitest';
import { computeBgDelta, isEmptyBgDelta, buildBgEvent } from '../bg-delta';
import type { BackgroundConfig } from '../types';

const baseBg: BackgroundConfig = {
  color: '#ffffff',
  pattern: 'none',
  patternSize: 20,
  patternColor: '#e0e0e0',
};

describe('computeBgDelta', () => {
  it('returns empty delta for identical configs', () => {
    const delta = computeBgDelta(baseBg, { ...baseBg });
    expect(isEmptyBgDelta(delta)).toBe(true);
  });

  it('computes color delta', () => {
    const newBg = { ...baseBg, color: '#f0f0f0' };
    const delta = computeBgDelta(baseBg, newBg);
    expect(delta.dColor).toEqual({ space: 'srgb', dr: -15, dg: -15, db: -15 });
    expect(delta.pattern).toBeUndefined();
    expect(delta.dPatternSize).toBeUndefined();
  });

  it('computes pattern enum delta', () => {
    const newBg = { ...baseBg, pattern: 'grid' as const };
    const delta = computeBgDelta(baseBg, newBg);
    expect(delta.pattern).toEqual({ prev: 'none', next: 'grid' });
  });

  it('computes pattern size delta', () => {
    const newBg = { ...baseBg, patternSize: 30 };
    const delta = computeBgDelta(baseBg, newBg);
    expect(delta.dPatternSize).toBe(10);
  });

  it('computes pattern color delta', () => {
    const newBg = { ...baseBg, patternColor: '#d0d0d0' };
    const delta = computeBgDelta(baseBg, newBg);
    expect(delta.dPatternColor).toEqual({ space: 'srgb', dr: -16, dg: -16, db: -16 });
  });

  it('computes multiple deltas simultaneously', () => {
    const newBg: BackgroundConfig = {
      color: '#000000',
      pattern: 'dots',
      patternSize: 40,
      patternColor: '#ff0000',
    };
    const delta = computeBgDelta(baseBg, newBg);
    expect(delta.dColor).toBeDefined();
    expect(delta.pattern).toEqual({ prev: 'none', next: 'dots' });
    expect(delta.dPatternSize).toBe(20);
    expect(delta.dPatternColor).toBeDefined();
  });
});

describe('buildBgEvent', () => {
  const mockId = () => 'bg:test001';
  const mockTs = () => '2026-01-01T00:00:00.000Z';

  it('returns null for no changes', () => {
    const event = buildBgEvent(baseBg, { ...baseBg }, 'session1', mockId, mockTs);
    expect(event).toBeNull();
  });

  it('builds a complete BG event', () => {
    const newBg = { ...baseBg, color: '#000000', pattern: 'grid' as const };
    const event = buildBgEvent(baseBg, newBg, 'session1', mockId, mockTs);
    expect(event).not.toBeNull();
    expect(event!.type).toBe('BG');
    expect(event!.sessionId).toBe('session1');
    expect(event!.id).toBe('bg:test001');
    expect(event!.dColor).toEqual({ space: 'srgb', dr: -255, dg: -255, db: -255 });
    expect(event!.pattern).toEqual({ prev: 'none', next: 'grid' });
  });
});
