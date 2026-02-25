import { describe, it, expect } from 'vitest';
import { parseHex, rgbToHex, computeSrgbChannelDelta, isZeroDelta } from '../color';

describe('parseHex', () => {
  it('parses #rrggbb format', () => {
    expect(parseHex('#ff0000')).toEqual({ r: 255, g: 0, b: 0 });
    expect(parseHex('#00ff00')).toEqual({ r: 0, g: 255, b: 0 });
    expect(parseHex('#0000ff')).toEqual({ r: 0, g: 0, b: 255 });
  });

  it('parses without # prefix', () => {
    expect(parseHex('ffffff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex('000000')).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('parses mixed values', () => {
    expect(parseHex('#e0e0e0')).toEqual({ r: 224, g: 224, b: 224 });
    expect(parseHex('#1e1e1e')).toEqual({ r: 30, g: 30, b: 30 });
  });
});

describe('rgbToHex', () => {
  it('converts RGB to hex', () => {
    expect(rgbToHex(255, 0, 0)).toBe('#ff0000');
    expect(rgbToHex(0, 255, 0)).toBe('#00ff00');
    expect(rgbToHex(0, 0, 255)).toBe('#0000ff');
    expect(rgbToHex(255, 255, 255)).toBe('#ffffff');
  });

  it('clamps values to 0-255', () => {
    expect(rgbToHex(300, -10, 128)).toBe('#ff0080');
  });

  it('rounds fractional values', () => {
    expect(rgbToHex(127.6, 0, 0)).toBe('#800000');
  });
});

describe('computeSrgbChannelDelta', () => {
  it('computes channel deltas', () => {
    const delta = computeSrgbChannelDelta('#ffffff', '#f0f0f0');
    expect(delta).toEqual({ space: 'srgb', dr: -15, dg: -15, db: -15 });
  });

  it('returns zero delta for identical colors', () => {
    const delta = computeSrgbChannelDelta('#ff0000', '#ff0000');
    expect(delta).toEqual({ space: 'srgb', dr: 0, dg: 0, db: 0 });
  });

  it('handles positive and negative deltas', () => {
    const delta = computeSrgbChannelDelta('#808080', '#ff0000');
    expect(delta).toEqual({ space: 'srgb', dr: 127, dg: -128, db: -128 });
  });
});

describe('isZeroDelta', () => {
  it('returns true for zero delta', () => {
    expect(isZeroDelta({ space: 'srgb', dr: 0, dg: 0, db: 0 })).toBe(true);
  });

  it('returns false for non-zero delta', () => {
    expect(isZeroDelta({ space: 'srgb', dr: 1, dg: 0, db: 0 })).toBe(false);
  });
});