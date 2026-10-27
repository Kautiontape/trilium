import { describe, expect, it } from 'vitest';
import { dayCapacity, parseClock } from './capacity.js';

const meeting = (start: string, end: string, extra: object = {}) => ({ start, end, ...extra });

describe('dayCapacity', () => {
  it('works out a 5 h meeting day', () => {
    const meetings = [meeting('10:00', '12:00'), meeting('13:00', '15:00'), meeting('16:00', '17:00')];
    expect(dayCapacity(meetings)).toEqual({
      windowMinutes: 480, bookedMinutes: 300, openMinutes: 180, targetMinutes: 117, bookedRatio: 0.625
    });
  });

  it('caps an empty day at 240 minutes', () => {
    expect(dayCapacity([])).toEqual({
      windowMinutes: 480, bookedMinutes: 0, openMinutes: 480, targetMinutes: 240, bookedRatio: 0
    });
  });

  it('ignores declined, all-day and untimed events', () => {
    const meetings = [
      meeting('10:00', '11:00', { declined: true }),
      meeting('', '', { allDay: true }),
      meeting('11:00', '12:00')
    ];
    expect(dayCapacity(meetings).bookedMinutes).toBe(60);
  });

  it('clips events to the window and counts overlapping time once', () => {
    const meetings = [meeting('09:00', '11:00'), meeting('10:30', '12:00'), meeting('17:30', '19:00')];
    // 10:00-12:00 and 17:30-18:00 are inside the window.
    expect(dayCapacity(meetings).bookedMinutes).toBe(150);
  });

  it('takes a custom window and floors the target at zero', () => {
    const full = dayCapacity([meeting('09:00', '13:00')], { workStart: '09:00', workEnd: '13:00' });
    expect(full).toEqual({
      windowMinutes: 240, bookedMinutes: 240, openMinutes: 0, targetMinutes: 0, bookedRatio: 1
    });
  });

  it('answers zeros for an empty or inverted window', () => {
    expect(dayCapacity([], { workStart: '18:00', workEnd: '10:00' })).toEqual({
      windowMinutes: 0, bookedMinutes: 0, openMinutes: 0, targetMinutes: 0, bookedRatio: 0
    });
  });

  it('parses HH:MM and rejects the rest', () => {
    expect(parseClock('09:30')).toBe(570);
    expect(parseClock('24:00')).toBe(1440);
    expect(parseClock('9:30')).toBeUndefined();
    expect(parseClock('25:00')).toBeUndefined();
  });
});
