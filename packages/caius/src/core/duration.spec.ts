import { describe, it, expect } from 'vitest';
import { formatMinutes, formatMinutesRange } from './duration.js';

describe('formatMinutes', () => {
  it('shows hours and minutes, leaving out a zero part', () => {
    expect([220, 45, 240, 0, 60, 61, 1500].map(formatMinutes)).toEqual(['3 h 40 m', '45 m', '4 h', '0 m', '1 h', '1 h 1 m', '25 h']);
  });
});

describe('formatMinutesRange', () => {
  it('shares the unit when both ends are whole hours', () => {
    expect(formatMinutesRange(180, 240)).toBe('3–4 h');
    expect(formatMinutesRange(720, 900)).toBe('12–15 h');
  });
  it('spells out both ends otherwise', () => {
    expect(formatMinutesRange(150, 240)).toBe('2 h 30 m–4 h');
  });
});
