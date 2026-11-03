import { describe, expect, it } from 'vitest';
import { DEFAULT_TARGETS, readRhythm, sectionOf } from './standing.js';

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
      start: '10:00', end: '23:00', workEnd: '18:00', noon: '12:00', rollover: '04:00', targets: DEFAULT_TARGETS,
      from: { start: 'rhythm', end: 'default', workEnd: 'default', noon: 'default', rollover: 'default', targets: 'default' },
    });
  });

  it('reads standup, the end of work, bedtime and the coordinates when they are there', () => {
    expect(readRhythm(FILLED)).toEqual({
      start: '09:30', end: '23:30', workEnd: '17:45', noon: '12:00', rollover: '04:00', targets: DEFAULT_TARGETS, latitude: 47.61, longitude: -122.33,
      from: { start: 'rhythm', end: 'rhythm', workEnd: 'rhythm', noon: 'default', rollover: 'default', targets: 'default' },
    });
  });

  it('reads a bedtime or an end of work without am or pm as the evening, and falls back when that cannot be', () => {
    const rhythm = (lines: string) => readRhythm(`## Rhythm\n\n- Work starts at standup, 10:00.\n${lines}`);
    expect(rhythm('- Bedtime: 11:30\n- Work ends at 6:00\n')).toMatchObject({ start: '10:00', end: '23:30', workEnd: '18:00' });
    expect(rhythm('- Bedtime: 6:00\n')).toMatchObject({ end: '23:00', from: { end: 'default' } });
    expect(rhythm('- Bedtime: 9:00 am\n')).toMatchObject({ end: '23:00', from: { end: 'default' } });
    expect(rhythm('- Bedtime: 10:30 pm\n')).toMatchObject({ end: '22:30', from: { end: 'rhythm' } });
  });

  it('reads a bedtime after midnight and before the rollover as the next morning', () => {
    const rhythm = (lines: string) => readRhythm(`## Rhythm\n\n- Standup at 10:00.\n${lines}`);
    expect(rhythm('- Bedtime: 1:00 AM\n')).toMatchObject({ end: '25:00', from: { end: 'rhythm' } });
    expect(rhythm('- Bedtime: 1:00\n')).toMatchObject({ end: '25:00' });
    expect(rhythm('- Bedtime: 00:30\n')).toMatchObject({ end: '24:30' });
    expect(rhythm('- Bedtime: midnight\n')).toMatchObject({ end: '24:00', from: { end: 'rhythm' } });
    expect(rhythm('- Bedtime: 3:45 am\n')).toMatchObject({ end: '27:45' });
  });

  it('rejects a bedtime after the rollover', () => {
    const rhythm = (lines: string) => readRhythm(`## Rhythm\n\n- Standup at 10:00.\n${lines}`);
    expect(rhythm('- Bedtime: 5:00 AM\n')).toMatchObject({ end: '23:00', from: { end: 'default' } });
    expect(rhythm('- The day rolls over at 02:00.\n- Bedtime: 3:00 AM\n')).toMatchObject({ end: '23:00', rollover: '02:00' });
    expect(rhythm('- The day rolls over at 02:00.\n- Bedtime: 1:30 AM\n')).toMatchObject({ end: '25:30' });
  });

  it('reads when the day rolls over, 04:00 unless the section says, and never after standup', () => {
    const rhythm = (lines: string) => readRhythm(`## Rhythm\n\n- Standup at 10:00.\n${lines}`);
    expect(rhythm('')).toMatchObject({ rollover: '04:00', from: { rollover: 'default' } });
    expect(rhythm('- The day rolls over at 04:30.\n')).toMatchObject({ rollover: '04:30', from: { rollover: 'rhythm' } });
    expect(rhythm('- My day ends at 3:00 am, not at midnight.\n')).toMatchObject({ rollover: '03:00', from: { rollover: 'rhythm' } });
    expect(rhythm('- Rollover: 5:00 AM\n')).toMatchObject({ rollover: '05:00' });
    expect(rhythm('- Rollover: midnight\n')).toMatchObject({ rollover: '00:00', from: { rollover: 'rhythm' } });
    expect(rhythm('- The day rolls over at 11:00.\n')).toMatchObject({ rollover: '04:00', from: { rollover: 'default' } });
    expect(readRhythm('## Rhythm\n\n- Standup at 03:00.\n')).toMatchObject({ rollover: '03:00', from: { rollover: 'default' } });
  });

  it('reads 12:30 as half past midnight, accepts a bedtime at the rollover, and ignores look-alike lines', () => {
    const rhythm = (lines: string) => readRhythm(`## Rhythm\n\n- Standup at 10:00.\n${lines}`);
    expect(rhythm('- Bedtime: 12:30\n')).toMatchObject({ end: '24:30' });
    expect(rhythm('- Bedtime: 4:00 AM\n')).toMatchObject({ end: '28:00' });
    expect(rhythm('- Workday ends at 6:00 pm.\n')).toMatchObject({ rollover: '04:00', from: { rollover: 'default' } });
    expect(rhythm('- The day rolls over at 08:00.\n')).toMatchObject({ rollover: '04:00', from: { rollover: 'default' } });
    expect(rhythm('- Work ends around midnight.\n- Bedtime: 1:00 AM\n')).toMatchObject({ end: '25:00' });
  });

  it('uses the defaults with no standing note or no Rhythm section', () => {
    const defaults = { start: '10:00', end: '23:00', workEnd: '18:00', noon: '12:00', rollover: '04:00', targets: DEFAULT_TARGETS, from: { start: 'default', end: 'default', workEnd: 'default', noon: 'default', rollover: 'default', targets: 'default' } };
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

describe('readRhythm noon and targets', () => {
  const rhythm = (lines: string) => readRhythm(`## Rhythm\n\n- Standup at 10:00.\n- Work ends at 18:00.\n${lines}\n`);

  it('reads the edge of Morning and Afternoon from either wording', () => {
    expect(rhythm('- Afternoon starts at 13:00.')).toMatchObject({ noon: '13:00', from: { noon: 'rhythm' } });
    expect(rhythm('- Lunch at 12:30.')).toMatchObject({ noon: '12:30' });
    expect(rhythm('- Lunch at 8:00.')).toMatchObject({ noon: '12:00', from: { noon: 'default' } });
    expect(rhythm('')).toMatchObject({ noon: '12:00', from: { noon: 'default' } });
  });
  it('reads the old Capacity wording: the evening range is Growth', () => {
    const r = rhythm('- Capacity: 180–240 work minutes a day, and 45–60 minutes in the evening.');
    expect(r.targets).toEqual({ foundation: { min: 180, max: 240 }, growth: { min: 45, max: 60 } });
    expect(r.from.targets).toBe('rhythm');
  });
  it('reads the new wording in hours, minutes, with a hyphen or an en dash', () => {
    expect(rhythm('- Capacity: Foundation 3–4 h, Growth 1–2 h, Recharge at least one thing.').targets).toEqual({
      foundation: { min: 180, max: 240 }, growth: { min: 60, max: 120 },
    });
    expect(rhythm('- Capacity: Foundation 2.5-3 hours, Growth 30-45 minutes.').targets).toEqual({
      foundation: { min: 150, max: 180 }, growth: { min: 30, max: 45 },
    });
  });
  it('keeps the default for a target the line leaves out, and for no Capacity line', () => {
    expect(rhythm('- Capacity: Growth 1–3 h.').targets).toEqual({ foundation: DEFAULT_TARGETS.foundation, growth: { min: 60, max: 180 } });
    expect(rhythm('- Capacity: as much as fits.')).toMatchObject({ targets: DEFAULT_TARGETS, from: { targets: 'default' } });
    expect(rhythm('')).toMatchObject({ targets: DEFAULT_TARGETS });
  });
});
