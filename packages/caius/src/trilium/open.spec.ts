import { describe, expect, it } from 'vitest';
import { daysLate } from './open.js';

describe('daysLate', () => {
  const now = new Date(2026, 9, 28, 15, 30); // Wed 28 Oct 2026, ISO week 44

  it('counts from the last day of a day, week or month period', () => {
    expect(daysLate('2026-10-26', now)).toBe(2);
    expect(daysLate('2026-10-27', now)).toBe(1);
    expect(daysLate('2026-W43', now)).toBe(3); // ends Sun 25 Oct
    expect(daysLate('2026-09', now)).toBe(28); // ends 30 Sep
    expect(daysLate('2025-W01', now)).toBe(Math.round((Date.UTC(2026, 9, 28) - Date.UTC(2025, 0, 5)) / 86_400_000)); // week 1 of 2025 ends Sun 5 Jan
  });

  it('is zero for the current or a future period and null for a bad key', () => {
    expect(daysLate('2026-10-28', now)).toBe(0);
    expect(daysLate('2026-W44', now)).toBe(0);
    expect(daysLate('2026-11', now)).toBe(0);
    expect(daysLate('', now)).toBeNull();
    expect(daysLate('someday', now)).toBeNull();
  });
});
