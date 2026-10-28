import { describe, expect, it } from 'vitest';
import { fakeTrilium as seeded, periodNote } from './helpers.js';
import { contextNotes, gatherContext } from './context.js';
import { sameContext } from './until.js';
import type { StoreNote } from './store.js';

/** A fake whose notes are keyed by their own noteId, as the fake store reads content by it. */
const fakeTrilium = (notes: Record<string, [StoreNote, string]>) =>
  seeded(Object.fromEntries(Object.values(notes).map(([note, html]) => [note.noteId, [note, html] as [StoreNote, string]])));
const bullets = (...items: string[]) => `<h3>Context</h3><ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
const day = (key: string, ...lines: string[]): [StoreNote, string] => [periodNote(`d${key}`, 'dateNote', key), bullets(...lines) + '<h2>☑️ Tasks</h2>'];
const week = (key: string, ...lines: string[]): [StoreNote, string] => [periodNote(`w${key}`, 'weekNote', key), bullets(...lines)];

// Monday 9 Nov 2026 is in 2026-W46; the week before is 2026-W45.
const NOTES = {
  own: day('2026-11-09', 'Own line'),
  fri: day('2026-11-06', 'Fri line', 'Shared line (until Wed 11 Nov)', 'Old news (until Fri 6 Nov)'),
  thu: day('2026-11-05', 'Thu line'),
  wed: day('2026-11-04', 'Wed line'),
  tue: day('2026-11-03', 'Too old'),
  sat: day('2026-11-07', 'Weekend line'),
  w46: week('2026-W46', 'Standing note', 'Jaco out all week (until Fri 13 Nov)'),
  w45: week('2026-W45', 'Last week standing', 'Shared line (until Fri 6 Nov)'),
  w44: week('2026-W44', 'Two weeks back'),
};
const ids = (r: { context: { text: string }[] }) => r.context.map((c) => c.text);

describe('contextNotes', () => {
  it('names the notes gatherContext reads, marking last week on a Monday as read for that day only', () => {
    expect(contextNotes('2026-11-09')).toEqual([
      { period: 'week', key: '2026-W46' },
      { period: 'week', key: '2026-W45', oneDay: true },
      { period: 'day', key: '2026-11-09' },
      { period: 'day', key: '2026-11-06' },
      { period: 'day', key: '2026-11-05' },
      { period: 'day', key: '2026-11-04' },
    ]);
    expect(contextNotes('2026-11-11').map((n) => n.key)).toEqual(['2026-W46', '2026-11-11', '2026-11-10', '2026-11-09', '2026-11-06']);
  });
});

describe('gatherContext', () => {
  it('on a Monday reads the day, the last 3 workdays, this week and last week', async () => {
    const fake = fakeTrilium(NOTES);
    const out = await gatherContext(fake.api, '2026-11-09');
    expect(out.date).toBe('2026-11-09');
    expect(ids(out).sort()).toEqual(['Jaco out all week', 'Last week standing', 'Own line', 'Shared line', 'Standing note']);
    // Expired (Old news, until 6 Nov < 9 Nov), an earlier day's lines without an until (Fri, Thu and
    // Wed line), the 4th workday back, the weekend and W44 are out.
    const shared = out.context.find((c) => c.text === 'Shared line');
    expect(shared).toMatchObject({ period: 'day', key: '2026-11-06', until: '2026-11-11', noteId: 'd2026-11-06' });
  });

  it('on another day skips last week, and counts workdays back across the weekend', async () => {
    const fake = fakeTrilium(NOTES);
    const out = await gatherContext(fake.api, '2026-11-11');
    // Wed 11 Nov: the last 3 workdays are Tue 10, Mon 9 and Fri 6.
    expect(ids(out).sort()).toEqual(['Jaco out all week', 'Shared line', 'Standing note']);
  });

  it('keeps the newest of two lines with the same text, newest first', async () => {
    const fake = fakeTrilium({
      a: day('2026-11-10', 'same   text (until Fri 13 Nov)'),
      b: week('2026-W46', 'Same text', 'Only in the week'),
      c: day('2026-11-09', 'Same text (until Thu 12 Nov)'),
    });
    const out = await gatherContext(fake.api, '2026-11-10');
    expect(out.context).toEqual([
      { text: 'same text', until: '2026-11-13', period: 'day', key: '2026-11-10', noteId: 'd2026-11-10' },
      { text: 'Only in the week', period: 'week', key: '2026-W46', noteId: 'w2026-W46' },
    ]);
  });

  it('reads two lines that differ only in case, spacing and trailing punctuation as one', async () => {
    // Round 2: Week 45 held the ZAP-2590 line twice, once with a full stop.
    const fake = fakeTrilium({
      a: week('2026-W45', 'ZAP-2590 is open; Jira&#39;s Done is a mistake.', 'zap-2590 is  open; Jira&#39;s Done is a mistake'),
    });
    expect(ids(await gatherContext(fake.api, '2026-11-06'))).toEqual(['zap-2590 is open; Jira\'s Done is a mistake']);
    expect(sameContext('ZAP-2590 is open.')).toBe(sameContext(' zap-2590  IS open '));
    expect(sameContext('Done!;')).toBe('done');
  });

  it('holds a day note line without an until on that day only, and never lets it hide a week copy', async () => {
    // Round 2: Thursday's overlap answer still showed on Friday and the next Monday.
    const fake = fakeTrilium({
      thu: day('2026-11-05', 'Take Incident Review over Vendor Onboarding at 11:00', 'Jaco out', 'Freeze on (until Fri 6 Nov)'),
      w45: week('2026-W45', 'Jaco out'),
    });
    expect(ids(await gatherContext(fake.api, '2026-11-05')).sort()).toEqual(['Freeze on', 'Jaco out', 'Take Incident Review over Vendor Onboarding at 11:00']);
    const friday = await gatherContext(fake.api, '2026-11-06');
    expect(ids(friday).sort()).toEqual(['Freeze on', 'Jaco out']);
    expect(friday.context.find((c) => c.text === 'Jaco out')).toMatchObject({ period: 'week', key: '2026-W45' });
  });

  it('reads a ranged line only inside its range, with its start', async () => {
    const fake = fakeTrilium({ w: week('2026-W45', 'Sam is out Thu–Fri (from Thu 5 Nov until Fri 6 Nov)') });
    expect(ids(await gatherContext(fake.api, '2026-11-04'))).toEqual([]);
    expect((await gatherContext(fake.api, '2026-11-05')).context).toEqual([
      { text: 'Sam is out Thu–Fri', from: '2026-11-05', until: '2026-11-06', period: 'week', key: '2026-W45', noteId: 'w2026-W45' },
    ]);
    expect(ids(await gatherContext(fake.api, '2026-11-09'))).toEqual([]);
  });

  it('lets a newer expired line hide the older open-ended one', async () => {
    const fake = fakeTrilium({
      a: week('2026-W45', 'Jaco out'),
      b: day('2026-11-05', 'Jaco out (until 5 Nov)'),
      c: day('2026-11-06', 'Other (until 9 Nov)'),
    });
    expect(ids(await gatherContext(fake.api, '2026-11-06'))).toEqual(['Other']);
    // Still in force a day earlier: the newer line wins and carries its date.
    const early = await gatherContext(fake.api, '2026-11-05');
    expect(early.context.find((c) => c.text === 'Jaco out')).toMatchObject({ key: '2026-11-05', until: '2026-11-05' });
  });

  it('reads missing, protected and non-text notes as nothing, and never creates a note', async () => {
    const locked = day('2026-11-06', 'Secret');
    locked[0] = { ...locked[0], isProtected: true };
    const fake = fakeTrilium({ own: day('2026-11-09', 'Own line'), locked });
    expect(ids(await gatherContext(fake.api, '2026-11-09'))).toEqual(['Own line']);
    expect(fake.log).toEqual([]);
    expect((await gatherContext(fakeTrilium({}).api, '2026-11-09')).context).toEqual([]);
  });
});
