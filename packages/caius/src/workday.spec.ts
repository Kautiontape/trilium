import { describe, expect, it } from 'vitest';
import { lastWorkday, nextWorkday } from './workday.js';

const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

describe('workdays', () => {
  it('skip the weekend going forward: Fri → Mon, Sat → Mon, Sun → Mon', () => {
    // 2026-11-02 is a Monday.
    const days = ['2026-11-02', '2026-11-03', '2026-11-06', '2026-11-07', '2026-11-08'];
    const next = days.map((d) => key(nextWorkday(new Date(`${d}T15:30`))));
    expect(next).toEqual(['2026-11-03', '2026-11-04', '2026-11-09', '2026-11-09', '2026-11-09']);
  });

  it('skip the weekend going back: Mon → Fri, Sun → Fri, Sat → Fri', () => {
    const days = ['2026-11-09', '2026-11-03', '2026-11-08', '2026-11-07', '2026-11-06'];
    const last = days.map((d) => key(lastWorkday(new Date(`${d}T15:30`))));
    expect(last).toEqual(['2026-11-06', '2026-11-02', '2026-11-06', '2026-11-06', '2026-11-05']);
  });

  it('cross month and year ends, and answer a local midnight', () => {
    expect(key(nextWorkday(new Date(2026, 11, 31)))).toBe('2027-01-01');
    expect(key(nextWorkday(new Date(2027, 0, 1)))).toBe('2027-01-04');
    expect(key(lastWorkday(new Date(2027, 0, 4)))).toBe('2027-01-01');
    const at = nextWorkday(new Date(2026, 10, 6, 17, 30));
    expect([at.getHours(), at.getMinutes()]).toEqual([0, 0]);
  });
});
