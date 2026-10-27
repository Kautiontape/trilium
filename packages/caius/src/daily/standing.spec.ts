import { describe, expect, it } from 'vitest';
import { readRhythm, sectionOf } from './standing.js';

const UNFILLED = `## Rhythm

*   Work starts at standup, 10:00. Nothing is planned before it.
*   The day runs to bedtime, and the evening is planned too. Bedtime: ? (to fill).
*   Location for the weather: ? (to fill).

## People

*   **Sam**: tests the tickets.

## Brief rules

*   Nothing is planned before standup.
*   Open time is work time.
`;

const FILLED = `## Rhythm

- Standup at 9:30.
- Work ends at 17:45, then the evening.
- Bedtime: 23:30.
- Location for the weather: 47.61, -122.33 (Seattle).
`;

describe('readRhythm', () => {
  it('reads standup and falls back to 23:00 and 18:00 when bedtime and the end of work are not filled in', () => {
    expect(readRhythm(UNFILLED)).toEqual({
      start: '10:00', end: '23:00', workEnd: '18:00',
      from: { start: 'rhythm', end: 'default', workEnd: 'default' },
    });
  });

  it('reads standup, the end of work, bedtime and the coordinates when they are there', () => {
    expect(readRhythm(FILLED)).toEqual({
      start: '09:30', end: '23:30', workEnd: '17:45', latitude: 47.61, longitude: -122.33,
      from: { start: 'rhythm', end: 'rhythm', workEnd: 'rhythm' },
    });
  });

  it('reads a bedtime or an end of work without am or pm as the evening, and falls back when that cannot be', () => {
    const rhythm = (lines: string) => readRhythm(`## Rhythm\n\n- Work starts at standup, 10:00.\n${lines}`);
    expect(rhythm('- Bedtime: 11:30\n- Work ends at 6:00\n')).toMatchObject({ start: '10:00', end: '23:30', workEnd: '18:00' });
    expect(rhythm('- Bedtime: 1:00\n')).toMatchObject({ end: '23:00', from: { end: 'default' } });
    expect(rhythm('- Bedtime: 9:00 am\n')).toMatchObject({ end: '23:00', from: { end: 'default' } });
    expect(rhythm('- Bedtime: 10:30 pm\n')).toMatchObject({ end: '22:30', from: { end: 'rhythm' } });
  });

  it('uses the defaults with no standing note or no Rhythm section', () => {
    const defaults = { start: '10:00', end: '23:00', workEnd: '18:00', from: { start: 'default', end: 'default', workEnd: 'default' } };
    expect(readRhythm(null)).toEqual(defaults);
    expect(readRhythm('## People\n\n- Standup at 9:00\n')).toEqual(defaults);
  });
});

describe('sectionOf', () => {
  it('returns a section body verbatim, up to the next heading of the same or a higher level', () => {
    expect(sectionOf(UNFILLED, 'Brief rules')).toBe('*   Nothing is planned before standup.\n*   Open time is work time.');
    expect(sectionOf(UNFILLED, 'people')).toBe('*   **Sam**: tests the tickets.');
    expect(sectionOf(UNFILLED, 'Missing')).toBeNull();
    expect(sectionOf(null, 'Brief rules')).toBeNull();
  });
});
