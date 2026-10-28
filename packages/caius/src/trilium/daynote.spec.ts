import { describe, expect, it } from 'vitest';
import { critical, fakeTrilium, li, periodNote, ul } from './helpers.js';
import { parseContext } from './until.js';
import { addContext, addContextLine, formatUntil, replaceMeetings, setMeetings } from './daynote.js';
import { readPlan } from './plan-read.js';
import { openTasks } from './open.js';
import { loadJournal } from './journal.js';
import { scanDocs } from '../index/index.js';
import { TRILIUM_CONFIG } from './config.js';
import { forwardTasks } from './forward.js';
import { inspectSuggested, placeForwarded, setTaskState } from './plan-html.js';
import { acceptTasks, addTasks } from './plan.js';

const NOW = new Date(2026, 10, 6, 9, 0);
const INCLUDE = '<section class="include-note" data-note-id="brief" data-box-size="expandable">&nbsp;</section>';
const bullets = (...items: string[]) => `<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
const MEETINGS = `<h3>Meetings</h3>${bullets('10:00 Standup (Sasha, James)', '14:00 Review')}`;
const CONTEXT = `<h3>Context</h3>${bullets('ZAP-2590 is open; Jira&#39;s Done is a mistake (until Fri 6 Nov)', 'Jaco out all week (until Fri 30 Oct)')}`;
const TASKS = `<h2>☑️ Tasks</h2>${ul(li('e1', 'Write the spec ~30m'), li('e2', 'Review PR ~1h'))}`;
const ASIDE = critical(li('ec', 'Ship the fix ~1h'));
const SUGGESTED = `<h3>Suggested</h3>${ul(li('es', 'Get X done: because Y ~30m'))}`;
const DAY = INCLUDE + MEETINGS + CONTEXT + ASIDE + TASKS + SUGGESTED;

const journal = (html: string, key = '2026-11-06') => fakeTrilium({ d: [periodNote('d', 'dateNote', key), html] });

describe('Meetings and Context are not tasks', () => {
  it('leave capacity, lanes and the critical block alone, with a to-do under Context', async () => {
    const html = INCLUDE + MEETINGS + CONTEXT.replace('</ul>', `</ul>${ul(li('ex', 'Chase it ~2h'))}`) + ASIDE + TASKS + SUGGESTED;
    const fake = journal(html);
    const plan = await readPlan(fake.api, 'day', '2026-11-06', NOW);
    expect(plan.capacity.estimatedCount).toBe(3); // e1, e2 and the critical one
    expect(plan.capacity.plannedMinutes).toBe(30 + 60 + 60);
    expect(plan.critical.map((t) => t.text)).toEqual(['Ship the fix']);
    expect(plan.sections.flatMap((s) => s.tasks.map((t) => t.listItemId))).toEqual(['e1', 'e2']);
    expect(plan.suggested.map((t) => t.listItemId)).toEqual(['es']);

    const load = await loadJournal(fake.api);
    const open = openTasks(load.docs, scanDocs(load.docs, TRILIUM_CONFIG, NOW));
    expect(open.map((t) => t.listItemId).sort()).toEqual(['e1', 'e2', 'ec']);
  });

  it('keep the critical block counted when Context is missing, and under a #### inside Context', async () => {
    for (const html of [INCLUDE + MEETINGS + ASIDE + TASKS, INCLUDE + MEETINGS + CONTEXT.replace('<ul>', '<h4>Sub</h4><ul>') + ASIDE + TASKS]) {
      const plan = await readPlan(journal(html).api, 'day', '2026-11-06', NOW);
      expect(plan.critical.map((t) => t.listItemId)).toEqual(['ec']);
      expect(plan.capacity.estimatedCount).toBe(3);
      expect(plan.context.length).toBe(html.includes('Context') ? 1 : 0);
    }
  });

  it('are returned as meetings and context, expired lines apart', async () => {
    const plan = await readPlan(journal(DAY).api, 'day', '2026-11-06', NOW);
    expect(plan.meetings).toEqual(['10:00 Standup (Sasha, James)', '14:00 Review']);
    expect(plan.context).toEqual([{ text: "ZAP-2590 is open; Jira's Done is a mistake", until: '2026-11-06' }]);
    expect(plan.expiredContext).toEqual([{ text: 'Jaco out all week', until: '2026-10-30' }]);
  });

  it('are read from a week note, resolving until against the week', async () => {
    const week = periodNote('w', 'weekNote', '2026-W45');
    const html = '<h3>Context</h3>' + bullets('Jaco out all week (until Fri 6 Nov)', 'Freeze (until 2026-11-02)', 'Standing note') + TASKS;
    const plan = await readPlan(fakeTrilium({ w: [week, html] }).api, 'week', '2026-W45', new Date(2026, 10, 4));
    expect(plan.context).toEqual([{ text: 'Jaco out all week', until: '2026-11-06' }, { text: 'Standing note' }]);
    expect(plan.expiredContext).toEqual([{ text: 'Freeze', until: '2026-11-02' }]);
    expect(plan.capacity.estimatedCount).toBe(2);
  });

  it('are never a forward target, and a to-do under them cannot be forwarded', async () => {
    const html = INCLUDE + CONTEXT.replace('</ul>', `</ul>${ul(li('ex', 'Chase it'))}`) + TASKS;
    expect(placeForwarded(html, '<li>NEW</li>', null)).toContain('Review PR ~1h</span></label></li><li>NEW</li>');
    const fake = journal(html);
    const [res] = await forwardTasks(fake.api, [{ noteId: 'd', listItemId: 'ex', to: '2026-11-09' }], { dryRun: true });
    expect(res).toMatchObject({ status: 'skipped', reason: 'not_live' });
  });
});

describe('to-dos under Meetings and Context, everywhere', () => {
  const html = INCLUDE + CONTEXT.replace('</ul>', `</ul>${ul(li('ex', 'Chase it'))}`) + '<h4>Suggested</h4>' + ul(li('ey', 'Hidden suggestion')) + TASKS;
  const states = new Map<string, string>();

  it('cannot be set done, doing or cancelled, nor taken as suggested', () => {
    for (const action of ['done', 'start', 'drop'] as const) {
      expect(setTaskState(html, 'ex', action, { states, reason: 'r' })).toMatchObject({ ok: false, reason: 'not_live' });
    }
    expect(setTaskState(html, 'e1', 'done', { states })).toMatchObject({ ok: true });
    expect(inspectSuggested(html, 'ey')).toEqual({ ok: false, reason: 'not_live' });
    expect(inspectSuggested(INCLUDE + TASKS + SUGGESTED, 'es')).toMatchObject({ ok: true });
  });

  it('answer not_live for an already-moved item, before already_moved', async () => {
    const moved = li('ex', 'Done', { state: '_rescheduled' });
    const fake = journal(INCLUDE + MEETINGS + ul(moved) + TASKS);
    const [res] = await forwardTasks(fake.api, [{ noteId: 'd', listItemId: 'ex', to: '2026-11-09' }], { dryRun: true });
    expect(res).toMatchObject({ status: 'skipped', reason: 'not_live' });
  });

  it('are never made by adding or accepting into a Meetings or Context heading', async () => {
    const fake = journal(DAY);
    const adds = await addTasks(fake.api, [{ date: '2026-11-06', section: 'Context', text: 'x' }, { date: '2026-11-06', section: '🗓 Meetings', text: 'y' }]);
    expect(adds).toMatchObject([{ status: 'skipped', reason: 'prose_section' }, { status: 'skipped', reason: 'prose_section' }]);
    const [acc] = await acceptTasks(fake.api, [{ noteId: 'd', listItemId: 'es', section: 'Context' }]);
    expect(acc).toMatchObject({ status: 'skipped', reason: 'prose_section' });
    expect(fake.html.d).toBe(DAY);
    expect(await addTasks(fake.api, [{ date: '2026-11-06', section: 'Work', text: 'z' }])).toMatchObject([{ status: 'added' }]);
  });
});

describe('until', () => {
  it('reads Fri 6 Nov, 6 Nov and 2026-11-06 against the note date, to the nearest year', () => {
    const lines = ['a (until Fri 6 Nov)', 'b (until 6 Nov)', 'c (until 2026-11-06)', 'd (until 6 November 2026)', 'e (UNTIL  Fri 6 Nov )'];
    expect(parseContext(lines, '2026-11-06').context.map((c) => c.until)).toEqual(Array(5).fill('2026-11-06'));
    expect(parseContext(['a (until 6 Jan)'], '2026-12-30').context[0]?.until).toBe('2027-01-06');
    expect(parseContext(['a (until 30 Dec)'], '2027-01-04').expiredContext[0]?.until).toBe('2026-12-30');
    // A year-less date is the next occurrence, or the previous one when that is over 300 days away.
    expect(parseContext(['a (until 15 Jun)'], '2026-12-10').context[0]?.until).toBe('2027-06-15');
    expect(parseContext(['a (until 15 Jun)'], '2026-06-15').context[0]?.until).toBe('2026-06-15');
    expect(parseContext(['a (until 6 Nov)'], '2026-11-07').expiredContext).toEqual([{ text: 'a', until: '2026-11-06' }]);
  });

  it('keeps text whole when the suffix is not a date, drops expired ones against the plan date', () => {
    expect(parseContext(['a (until the release)', 'b (until 31 Feb)', 'plain'], '2026-11-06').context).toEqual([
      { text: 'a (until the release)' }, { text: 'b (until 31 Feb)' }, { text: 'plain' },
    ]);
    const out = parseContext(['a (until Fri 6 Nov)'], '2026-11-02', '2026-11-07');
    expect(out.context).toEqual([]);
    expect(out.expiredContext).toEqual([{ text: 'a', until: '2026-11-06' }]);
  });
});

describe('Context ranges', () => {
  const range = 'Sam is out Thu–Fri (from Thu 5 Nov until Fri 6 Nov)';

  it('reads (from … until …) and (from …), and holds the line only inside its range', () => {
    const lines = [range, 'Freeze (from 9 Nov)'];
    const sam = { text: 'Sam is out Thu–Fri', from: '2026-11-05', until: '2026-11-06' };
    const freeze = { text: 'Freeze', from: '2026-11-09' };
    expect(parseContext(lines, '2026-11-02', '2026-11-04')).toEqual({ context: [], expiredContext: [], pendingContext: [sam, freeze] });
    expect(parseContext(lines, '2026-11-02', '2026-11-05')).toEqual({ context: [sam], expiredContext: [], pendingContext: [freeze] });
    expect(parseContext(lines, '2026-11-02', '2026-11-09')).toEqual({ context: [freeze], expiredContext: [sam], pendingContext: [] });
  });

  it('writes both ends, refuses a start after the end, and keeps the start when the end is rewritten', async () => {
    const fake = fakeTrilium({ w: [periodNote('w', 'weekNote', '2026-W45'), TASKS] });
    const added = await addContext(fake.api, { week: '2026-W45', text: 'Sam is out Thu–Fri', from: '2026-11-05', until: '2026-11-06' }, { now: NOW });
    expect(added).toMatchObject({ status: 'added', line: range });
    expect(await addContext(fake.api, { week: '2026-W45', text: 'x', from: '2026-11-06', until: '2026-11-05' }, { now: NOW })).toMatchObject({ status: 'skipped', reason: 'bad_request' });
    const kept = await addContext(fake.api, { week: '2026-W45', text: 'Sam is out Thu–Fri', until: '2026-11-08' }, { now: new Date(2026, 10, 5, 9) });
    expect(kept).toMatchObject({ status: 'updated', line: 'Sam is out Thu–Fri (from Thu 5 Nov until Sun 8 Nov)' });
  });
});

describe('a range line written twice', () => {
  it('is a duplicate before it starts, in a week note and for a day of that week', async () => {
    const fake = fakeTrilium({ w: [periodNote('w', 'weekNote', '2026-W45'), TASKS] });
    const MON = new Date(2026, 10, 2, 9);
    const line = { text: 'Sam is out Thu–Fri', from: '2026-11-05', until: '2026-11-06' };
    expect(await addContext(fake.api, { week: '2026-W45', ...line }, { now: MON })).toMatchObject({ status: 'added' });
    expect(await addContext(fake.api, { week: '2026-W45', ...line }, { now: MON })).toMatchObject({ status: 'skipped', reason: 'duplicate' });
    expect(await addContext(fake.api, { date: '2026-11-02', ...line }, { now: MON })).toMatchObject({ status: 'skipped', reason: 'duplicate' });
    expect(fake.html.w.match(/Sam is out/g)).toHaveLength(1);
  });
});

describe('replaceMeetings', () => {
  const lines = ['09:30 Standup', 'a & b <c>'];
  const block = '<ul><li>09:30 Standup</li><li>a &amp; b &lt;c&gt;</li></ul>';

  it('replaces only what is under the heading, leaving the tasks and the critical block byte for byte', () => {
    const out = replaceMeetings(DAY, lines);
    expect(out).toBe(INCLUDE + `<h3>Meetings</h3>${block}` + CONTEXT + ASIDE + TASKS + SUGGESTED);
    const noContext = INCLUDE + MEETINGS + ASIDE + TASKS;
    expect(replaceMeetings(noContext, lines)).toBe(INCLUDE + `<h3>Meetings</h3>${block}` + ASIDE + TASKS);
  });

  it('creates the heading below the include-note, or at the top, and empties it for no lines', () => {
    expect(replaceMeetings(INCLUDE + CONTEXT + TASKS, lines)).toBe(INCLUDE + `<h3>Meetings</h3>${block}` + CONTEXT + TASKS);
    expect(replaceMeetings(TASKS, lines)).toBe(`<h3>Meetings</h3>${block}` + TASKS);
    expect(replaceMeetings(DAY, [])).toBe(INCLUDE + '<h3>Meetings</h3>' + CONTEXT + ASIDE + TASKS + SUGGESTED);
  });

  it('stops at a heading of the same or higher level, not at a lower one', () => {
    const html = '<h3>Meetings</h3><h4>Am</h4>' + bullets('x') + '<h2>Tasks</h2>';
    expect(replaceMeetings(html, ['y'])).toBe('<h3>Meetings</h3><ul><li>y</li></ul><h2>Tasks</h2>');
  });
});

describe('setMeetings', () => {
  it('writes the block with a compare-and-swap and changes nothing else in the note', async () => {
    const fake = journal(DAY);
    const res = await setMeetings(fake.api, { date: '2026-11-06', lines: ['09:30 Standup'] });
    expect(res).toEqual({ date: '2026-11-06', status: 'updated', writtenNoteId: 'd' });
    expect(fake.html.d).toBe(replaceMeetings(DAY, ['09:30 Standup']));
    expect(fake.log).toEqual(['put d']);
    expect(await setMeetings(fake.api, { date: '2026-11-06', lines: ['09:30 Standup'] })).toMatchObject({ status: 'unchanged' });
    expect(fake.log).toEqual(['put d']);
  });

  it('creates the day note from the template when missing, but not on a dry run', async () => {
    const dry = fakeTrilium({});
    expect(await setMeetings(dry.api, { date: '2026-11-09', lines: ['10:00 Standup'] }, { dryRun: true })).toMatchObject({ status: 'dry-run', after: expect.stringContaining('10:00 Standup') });
    expect(dry.log).toEqual([]);
    const real = fakeTrilium({});
    expect(await setMeetings(real.api, { date: '2026-11-09', lines: ['10:00 Standup'] })).toMatchObject({ status: 'updated', writtenNoteId: 'new-2026-11-09' });
    expect(real.log).toEqual(['create dateNote=2026-11-09', 'put new-2026-11-09']);
  });

  it('skips a bad date, a protected note, and a note that changed meanwhile', async () => {
    expect(await setMeetings(journal(DAY).api, { date: '2026-11-31', lines: [] })).toMatchObject({ status: 'skipped', reason: 'bad_request' });
    const locked = fakeTrilium({ d: [periodNote('d', 'dateNote', '2026-11-06', { isProtected: true }), DAY] });
    expect(await setMeetings(locked.api, { date: '2026-11-06', lines: [] })).toMatchObject({ status: 'skipped', reason: 'unreadable' });
    const racing = journal(DAY);
    const put = racing.api.putContent;
    racing.api.putContent = (id, html) => put(id, html, 'not what is stored');
    expect(await setMeetings(racing.api, { date: '2026-11-06', lines: ['x'] })).toMatchObject({ status: 'skipped', reason: 'edited' });
    expect(racing.html.d).toBe(DAY);
  });
});

describe('addContextLine', () => {
  it('appends a bullet to the Context list and leaves the rest byte for byte', () => {
    const out = addContextLine(DAY, 'a & b');
    expect(out).toBe(INCLUDE + MEETINGS + CONTEXT.replace('</ul>', '<li>a &amp; b</li></ul>') + ASIDE + TASKS + SUGGESTED);
  });

  it('creates the heading below Meetings, else below the include-note, else at the top', () => {
    const added = '<h3>Context</h3><ul><li>x</li></ul>';
    expect(addContextLine(INCLUDE + MEETINGS + ASIDE + TASKS, 'x')).toBe(INCLUDE + MEETINGS + added + ASIDE + TASKS);
    expect(addContextLine(INCLUDE + TASKS, 'x')).toBe(INCLUDE + added + TASKS);
    expect(addContextLine(TASKS, 'x')).toBe(added + TASKS);
  });

  it('adds a list to a Context heading that has none', () => {
    expect(addContextLine('<h3>Context</h3><h2>Tasks</h2>', 'x')).toBe('<h3>Context</h3><ul><li>x</li></ul><h2>Tasks</h2>');
  });
});

describe('formatUntil', () => {
  it('writes the short weekday, day and month, and the year only when a reader would resolve it wrongly', () => {
    expect(formatUntil('2026-11-06', '2026-11-02')).toBe('Fri 6 Nov');
    expect(parseContext([`x (until ${formatUntil('2026-11-06', '2026-11-02')})`], '2026-11-02').context).toEqual([{ text: 'x', until: '2026-11-06' }]);
    expect(formatUntil('2027-10-01', '2026-11-02')).toBe('Fri 1 Oct 2027');
  });
});

describe('addContext', () => {
  it('writes a line with its until to a day note, and skips text already in force as a duplicate', async () => {
    const fake = journal(DAY);
    const res = await addContext(fake.api, { date: '2026-11-06', text: 'Release frozen', until: '2026-11-13' }, { now: NOW });
    expect(res).toMatchObject({ status: 'added', writtenNoteId: 'd', line: 'Release frozen (until Fri 13 Nov)' });
    expect(fake.html.d).toContain('<li>Release frozen (until Fri 13 Nov)</li></ul>');
    const again = await addContext(fake.api, { date: '2026-11-06', text: ' release  FROZEN ', until: '2026-11-10' }, { now: NOW });
    expect(again).toMatchObject({ status: 'skipped', reason: 'duplicate' });
    // Trailing punctuation doesn't make a new line, nor does it stop the line being kept longer.
    expect(await addContext(fake.api, { date: '2026-11-06', text: 'Release frozen.' }, { now: NOW })).toMatchObject({ status: 'updated', line: 'Release frozen' });
    expect(fake.html.d).toContain('<li>Release frozen</li></ul>');
    expect(await addContext(fake.api, { date: '2026-11-06', text: 'release frozen!' }, { now: NOW })).toMatchObject({ status: 'skipped', reason: 'duplicate' });
    // An expired line is not in force, so the same text can be written again.
    expect(await addContext(fake.api, { date: '2026-11-06', text: 'Jaco out all week' }, { now: NOW })).toMatchObject({ status: 'added' });
  });

  it('counts a line in the week note as in force for a day of that week', async () => {
    const fake = fakeTrilium({
      w: [periodNote('w', 'weekNote', '2026-W45'), '<h3>Context</h3>' + bullets('Jaco out all week')],
      d: [periodNote('d', 'dateNote', '2026-11-06'), TASKS],
    });
    expect(await addContext(fake.api, { date: '2026-11-06', text: 'Jaco out all week' }, { now: NOW })).toMatchObject({ status: 'skipped', reason: 'duplicate' });
    expect(await addContext(fake.api, { week: '2026-W45', text: 'Jaco out all week' }, { now: NOW })).toMatchObject({ status: 'skipped', reason: 'duplicate' });
    const res = await addContext(fake.api, { week: '2026-W45', text: 'Board review moved', until: '2026-11-06' }, { now: NOW });
    expect(res).toMatchObject({ status: 'added', writtenNoteId: 'w', line: 'Board review moved (until Fri 6 Nov)' });
  });

  it('creates a missing note, but not on a dry run, and refuses an until before the note', async () => {
    const dry = fakeTrilium({});
    expect(await addContext(dry.api, { date: '2026-11-09', text: 'x' }, { dryRun: true, now: NOW })).toMatchObject({ status: 'dry-run', after: expect.stringContaining('<li>x</li>') });
    expect(dry.log).toEqual([]);
    const real = fakeTrilium({});
    expect(await addContext(real.api, { date: '2026-11-09', text: 'x' }, { now: NOW })).toMatchObject({ status: 'added', writtenNoteId: 'new-2026-11-09' });
    expect(real.log).toEqual(['create dateNote=2026-11-09', 'put new-2026-11-09']);
    expect(await addContext(real.api, { date: '2026-11-09', text: 'y', until: '2026-11-06' }, { now: NOW })).toMatchObject({ status: 'skipped', reason: 'bad_request' });
  });
});

describe('addContext keeping a line that lapses', () => {
  const WED = new Date(2026, 10, 4, 19, 0);
  const lapsing = (until: string) => `<h3>Context</h3><ul><li>ZAP-2590 is open (until ${until})</li></ul>${TASKS}`;

  it('extends the until of the copy in force in the week note in place, as a dry run first', async () => {
    const fake = fakeTrilium({ w: [periodNote('w', 'weekNote', '2026-W45'), lapsing('Wed 4 Nov')] });
    const dry = await addContext(fake.api, { week: '2026-W45', text: 'ZAP-2590 is open', until: '2026-11-13' }, { dryRun: true, now: WED });
    expect(dry).toMatchObject({ status: 'dry-run', writtenNoteId: 'w', line: 'ZAP-2590 is open (until Fri 13 Nov)' });
    expect(fake.log).toEqual([]);

    const res = await addContext(fake.api, { week: '2026-W45', text: 'ZAP-2590 is open', until: '2026-11-13' }, { now: WED });
    expect(res).toMatchObject({ status: 'updated', writtenNoteId: 'w', line: 'ZAP-2590 is open (until Fri 13 Nov)' });
    expect(fake.html.w).toBe(lapsing('Fri 13 Nov'));
    // Already in force that long: a duplicate.
    expect(await addContext(fake.api, { week: '2026-W45', text: 'ZAP-2590 is open', until: '2026-11-10' }, { now: WED })).toMatchObject({ status: 'skipped', reason: 'duplicate' });
    // No until keeps it for good.
    expect(await addContext(fake.api, { week: '2026-W45', text: 'ZAP-2590 is open' }, { now: WED })).toMatchObject({ status: 'updated', writtenNoteId: 'w', line: 'ZAP-2590 is open' });
    expect(fake.html.w).toBe(`<h3>Context</h3><ul><li>ZAP-2590 is open</li></ul>${TASKS}`);
  });

  it('extends the copy in force, the one with the latest until, when the note holds two', async () => {
    const two = '<h3>Context</h3><ul><li>ZAP-2590 is open (until Mon 2 Nov)</li><li>ZAP-2590 is open (until Wed 4 Nov)</li></ul>';
    const fake = fakeTrilium({ w: [periodNote('w', 'weekNote', '2026-W45'), two] });
    expect(await addContext(fake.api, { week: '2026-W45', text: 'ZAP-2590 is open', until: '2026-11-13' }, { now: WED })).toMatchObject({ status: 'updated' });
    expect(fake.html.w).toBe('<h3>Context</h3><ul><li>ZAP-2590 is open (until Mon 2 Nov)</li><li>ZAP-2590 is open (until Fri 13 Nov)</li></ul>');
  });

  it('writes the line to the note asked for when the copy in force is in another note, even a week note', async () => {
    // keep2.mts B: a Monday wind-down keeps a line in last week's note; that note stops being read after Monday.
    const MON = new Date(2026, 10, 9, 19, 0);
    const fake = fakeTrilium({ w: [periodNote('w', 'weekNote', '2026-W45'), lapsing('Mon 9 Nov')], m: [periodNote('m', 'dateNote', '2026-11-09'), TASKS] });
    expect(await addContext(fake.api, { date: '2026-11-09', text: 'ZAP-2590 is open', until: '2026-11-13' }, { now: MON })).toMatchObject({ status: 'added', writtenNoteId: 'm' });
    expect(fake.html.w).toBe(lapsing('Mon 9 Nov'));
    expect(fake.html.m).toContain('<li>ZAP-2590 is open (until Fri 13 Nov)</li>');

    // The same from a day of this week into next week's note.
    const thisWeek = fakeTrilium({ w: [periodNote('w', 'weekNote', '2026-W45'), lapsing('Fri 6 Nov')] });
    expect(await addContext(thisWeek.api, { week: '2026-W46', text: 'ZAP-2590 is open', until: '2026-11-13' }, { now: new Date(2026, 10, 6, 19) })).toMatchObject({ status: 'added', writtenNoteId: 'new-2026-W46' });
    expect(thisWeek.html.w).toBe(lapsing('Fri 6 Nov'));
  });

  it('extends a copy in the target day note in place, and writes a copy in an older day note to the target', async () => {
    const same = fakeTrilium({ t: [periodNote('t', 'dateNote', '2026-11-05'), lapsing('Thu 5 Nov')] });
    expect(await addContext(same.api, { date: '2026-11-05', text: 'ZAP-2590 is open', until: '2026-11-13' }, { now: WED })).toMatchObject({ status: 'updated', writtenNoteId: 't' });
    expect(same.html.t).toBe(lapsing('Fri 13 Nov'));

    const older = fakeTrilium({ w: [periodNote('w', 'dateNote', '2026-11-04'), lapsing('Thu 5 Nov')], t: [periodNote('t', 'dateNote', '2026-11-05'), TASKS] });
    expect(await addContext(older.api, { date: '2026-11-05', text: 'ZAP-2590 is open', until: '2026-11-13' }, { now: WED })).toMatchObject({ status: 'added', writtenNoteId: 't' });
    expect(older.html.w).toBe(lapsing('Thu 5 Nov'));
    expect(older.html.t).toContain('<li>ZAP-2590 is open (until Fri 13 Nov)</li>');
  });
});
