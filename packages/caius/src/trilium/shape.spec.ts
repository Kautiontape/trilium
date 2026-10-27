import { describe, expect, it } from 'vitest';
import { critical, fakeTrilium, li, periodNote, ul } from './helpers.js';
import { forwardTasks } from './forward.js';
import { placeForwarded } from './plan-html.js';
import { acceptTasks, addTasks } from './plan.js';
import { readPlan } from './plan-read.js';

// Notes in the day-note shape: include-note, Meetings, Context, the Important block, Tasks, Suggested.
const NOW = new Date(2026, 10, 6, 9, 0);
const INCLUDE = '<section class="include-note" data-note-id="brief" data-box-size="expandable">&nbsp;</section>';
const bullets = (...items: string[]) => `<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
const HEAD = INCLUDE + `<h3>Meetings</h3>${bullets('10:00 Standup')}<h3>Context</h3>${bullets('Standing note')}`;
const NO_ASIDE = '<aside class="admonition important"><p>[…]</p></aside>';
const day = (p: string, aside: string = critical(li(p + 'c', 'Ship the fix ~1h'))) =>
  HEAD + aside + `<h2>☑️ Tasks</h2>${ul(li(p + '1', 'Write the spec ~30m'))}<h3>Suggested</h3>${ul(li(p + 's', 'Idea ~30m'))}`;
const texts = (tasks: { text: string }[]) => tasks.map((t) => t.text);

describe('forwarding in the full day-note shape', () => {
  it('keeps an Important task Important in the target, in the aside, never in Context', async () => {
    const fake = fakeTrilium({ a: [periodNote('a', 'dateNote', '2026-11-06'), day('a')], b: [periodNote('b', 'dateNote', '2026-11-09'), day('b', NO_ASIDE)] });
    const [res] = await forwardTasks(fake.api, [{ noteId: 'a', listItemId: 'ac', to: '2026-11-09' }]);
    expect(res).toMatchObject({ status: 'moved' });
    const plan = await readPlan(fake.api, 'day', '2026-11-09', NOW);
    expect(texts(plan.critical).map((t) => t.split(' [from ')[0])).toEqual(['Ship the fix']);
    expect(plan.context).toEqual([{ text: 'Standing note' }]);
    expect(texts(plan.sections.flatMap((s) => s.tasks))).toEqual(['Write the spec']);
  });

  it('adds the aside to a target that has none', async () => {
    const bare = HEAD + `<h2>☑️ Tasks</h2>${ul(li('b1', 'Write the spec ~30m'))}`;
    const fake = fakeTrilium({ a: [periodNote('a', 'dateNote', '2026-11-06'), day('a')], b: [periodNote('b', 'dateNote', '2026-11-09'), bare] });
    await forwardTasks(fake.api, [{ noteId: 'a', listItemId: 'ac', to: '2026-11-09' }]);
    const plan = await readPlan(fake.api, 'day', '2026-11-09', NOW);
    expect(texts(plan.critical).map((t) => t.split(' [from ')[0])).toEqual(['Ship the fix']);
    expect(plan.context).toEqual([{ text: 'Standing note' }]);
  });

  it('puts a normal task under its own heading, and no heading name reaches a prose section', async () => {
    const fake = fakeTrilium({ a: [periodNote('a', 'dateNote', '2026-11-06'), day('a')], b: [periodNote('b', 'dateNote', '2026-11-09'), day('b', NO_ASIDE)] });
    await forwardTasks(fake.api, [{ noteId: 'a', listItemId: 'a1', to: '2026-11-09' }]);
    const plan = await readPlan(fake.api, 'day', '2026-11-09', NOW);
    expect(texts(plan.sections.flatMap((s) => s.tasks)).map((t) => t.split(' [from ')[0])).toEqual(['Write the spec', 'Write the spec']);
    expect(plan.context).toEqual([{ text: 'Standing note' }]);
    for (const name of ['Context', 'Meetings']) {
      const out = placeForwarded(day('b'), '<li>NEW</li>', name);
      expect(out.indexOf('NEW')).toBeGreaterThan(out.indexOf('☑️ Tasks'));
    }
  });
});

describe('placing a task under a heading nested in a prose section', () => {
  const nested = INCLUDE + `<h3>Meetings</h3>${bullets('10:00 Standup')}<h3>Context</h3><h4>Notes</h4>${bullets('x')}`
    + `<h2>☑️ Tasks</h2>${ul(li('e1', 'Write the spec ~30m'))}<h3>Suggested</h3>${ul(li('es', 'Idea ~30m'))}`;
  const underContext = '<h2>Context</h2>' + bullets('x') + '<h3>Suggested</h3>' + ul(li('es', 'Idea ~30m')) + '<h2>Tasks</h2>' + ul(li('e1', 'A ~30m'));
  const one = (html: string) => fakeTrilium({ d: [periodNote('d', 'dateNote', '2026-11-06'), html] });

  it('skips a heading under Context, however it is reached', async () => {
    const fake = one(nested);
    const added = await addTasks(fake.api, [{ date: '2026-11-06', section: 'Notes', text: 'added ~1h' }], { now: NOW });
    expect(added).toMatchObject([{ status: 'skipped', reason: 'prose_section' }]);
    const accepted = await acceptTasks(fake.api, [{ noteId: 'd', listItemId: 'es', section: 'Notes' }]);
    expect(accepted).toMatchObject([{ status: 'skipped', reason: 'prose_section' }]);
    expect(fake.html.d).toBe(nested);
    expect(await addTasks(fake.api, [{ date: '2026-11-06', section: '☑️ Tasks', text: 'ok ~1h' }], { now: NOW })).toMatchObject([{ status: 'added' }]);
  });

  it('skips the Suggested target when Suggested lies inside Context', async () => {
    const fake = one(underContext);
    const added = await addTasks(fake.api, [{ date: '2026-11-06', suggested: true, text: 'Book the venue ~1h' }], { now: NOW });
    expect(added).toMatchObject([{ status: 'skipped', reason: 'prose_section' }]);
    expect(fake.html.d).toBe(underContext);
  });
});
