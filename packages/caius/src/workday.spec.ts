import { describe, expect, it } from 'vitest';
import { DEFAULT_ROLLOVER, lastWorkday, nextWorkday, workdayClock, workdayKey, workdayMinutes, workdayNow } from './workday.js';

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

describe('the workday', () => {
  // 2026-11-03 is a Tuesday; 2026-11-06 a Friday.
  const at = (stamp: string) => new Date(`${stamp}:00`);

  it('is the previous date until the rollover', () => {
    expect(DEFAULT_ROLLOVER).toBe(240);
    expect(workdayKey(at('2026-11-03T00:00'), 240)).toBe('2026-11-02');
    expect(workdayKey(at('2026-11-03T03:59'), 240)).toBe('2026-11-02');
    expect(workdayKey(at('2026-11-03T04:00'), 240)).toBe('2026-11-03');
    expect(workdayKey(at('2026-11-03T23:59'), 240)).toBe('2026-11-03');
    expect(workdayKey(at('2026-11-03T00:00'), 0)).toBe('2026-11-03');
  });

  it('crosses month and year ends', () => {
    expect(workdayKey(at('2026-12-01T01:00'), 240)).toBe('2026-11-30');
    expect(workdayKey(at('2027-01-01T01:00'), 240)).toBe('2026-12-31');
  });

  it('keeps Friday through the small hours of Saturday, and composes with the workday steps', () => {
    expect(workdayKey(at('2026-11-07T01:00'), 240)).toBe('2026-11-06');
    expect(workdayKey(at('2026-11-07T04:00'), 240)).toBe('2026-11-07');
    expect(key(nextWorkday(workdayNow(at('2026-11-07T01:00'), 240)))).toBe('2026-11-09');
    expect(key(nextWorkday(workdayNow(at('2026-11-07T05:00'), 240)))).toBe('2026-11-09');
    expect(key(lastWorkday(workdayNow(at('2026-11-09T01:00'), 240)))).toBe('2026-11-06');
    expect(workdayKey(at('2026-11-09T01:00'), 240)).toBe('2026-11-08');
  });

  it('reads the clock of the small hours past 24:00', () => {
    const clock = (stamp: string) => workdayClock(workdayNow(at(stamp), 240), 240);
    expect(clock('2026-11-03T00:00')).toBe('24:00');
    expect(clock('2026-11-03T01:30')).toBe('25:30');
    expect(clock('2026-11-03T03:59')).toBe('27:59');
    expect(clock('2026-11-03T04:00')).toBe('04:00');
    expect(clock('2026-11-03T17:45')).toBe('17:45');
    expect(workdayMinutes(workdayNow(at('2026-11-03T01:30'), 240), 240)).toBe(25 * 60 + 30);
  });
});
