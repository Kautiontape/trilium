import { describe, expect, it } from 'vitest';
import { critical, fakeTrilium, li, periodNote, ul } from './helpers.js';
import { parseContext } from './until.js';
import { replaceMeetings, setMeetings } from './daynote.js';
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
