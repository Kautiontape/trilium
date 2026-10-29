import { describe, expect, it } from 'vitest';
import { critical, fakeTrilium, li, periodNote, ul } from './helpers.js';
import { forwardTasks } from './forward.js';
import { placeForwarded, placeInMainList, placeTask, takeOnDeck } from './plan-html.js';
import { addTasks, commitTasks } from './plan.js';
import { readPlan } from './plan-read.js';
import { loadJournal } from './journal.js';
import { openTasks } from './open.js';
import { scanDocs } from '../index/index.js';
import { TRILIUM_CONFIG } from './config.js';
import { sectionKind } from './sections.js';
import { DEFAULT_STATE_SYMBOLS } from './markdown.js';

// On deck: intended for the day, tracked as live tasks, apart from the committed list and its capacity.
const NOW = new Date(2026, 10, 6, 9, 0);
const TASKS = `<h2>☑️ Tasks</h2>${ul(li('t1', 'Write the spec ~1h'))}`;
const DECK = `<h3>On deck</h3>${ul(li('d1', 'Tidy the garage ~45m'), li('d2', 'Read the RFC'))}`;
const SUGGESTED = `<h3>Suggested</h3>${ul(li('s1', 'Get ZAP-1 done: because it waits (~30m)'))}`;
const texts = (tasks: { text: string }[]) => tasks.map((t) => t.text.split(' [from ')[0]);
const day = (id: string, key: string, html: string) => ({ [id]: [periodNote(id, 'dateNote', key), html] as [ReturnType<typeof periodNote>, string] });

describe('reading On deck', () => {
  it('keeps On deck tasks live and tracked but apart from the list, the Top 3 and the committed capacity', async () => {
    const fake = fakeTrilium(day('a', '2026-11-06', TASKS + DECK + SUGGESTED));
    const plan = await readPlan(fake.api, 'day', '2026-11-06', NOW);
    expect(texts(plan.sections.flatMap((s) => s.tasks))).toEqual(['Write the spec']);
    expect(texts(plan.top3)).toEqual(['Write the spec']);
    expect(texts(plan.onDeck)).toEqual(['Tidy the garage', 'Read the RFC']);
    expect(plan.capacity).toMatchObject({ plannedMinutes: 60, totalMinutes: 60, unestimatedCount: 0, onDeckMinutes: 75 });
    expect(plan.capacity.horizons.today).toBe(3);
    expect(sectionKind('On deck')).toBe('deck');

    // Every lane sees them: nothing on deck is lost.
    const { docs } = await loadJournal(fake.api);
    const open = openTasks(docs, scanDocs(docs, TRILIUM_CONFIG, NOW));
    expect(open.filter((t) => t.onDeck).map((t) => t.listItemId)).toEqual(['d1', 'd2']);
    expect(open.find((t) => t.listItemId === 't1')?.onDeck).toBe(false);
  });

  it('counts an Important task under the On deck heading as critical, not on deck', async () => {
    const fake = fakeTrilium(day('a', '2026-11-06', TASKS + `<h3>On deck</h3>${critical(li('c1', 'Pay the rent ~10m'))}`));
    const plan = await readPlan(fake.api, 'day', '2026-11-06', NOW);
    expect(texts(plan.critical)).toEqual(['Pay the rent']);
    expect(plan.onDeck).toEqual([]);
  });
});

describe('placing On deck', () => {
  it('creates On deck just above Suggested, at its level, and adds to it after', () => {
    const made = placeTask(TASKS + SUGGESTED, '<li>NEW</li>', { kind: 'onDeck' });
    expect(made).toBe(`${TASKS}<h3>On deck</h3><ul class="todo-list"><li>NEW</li></ul>${SUGGESTED}`);
    expect(placeTask(made, '<li>TWO</li>', { kind: 'section', name: 'on deck' })).toContain('<li>NEW</li><li>TWO</li></ul><h3>Suggested</h3>');
    // Without Suggested, at the end.
    expect(placeTask(TASKS, '<li>NEW</li>', { kind: 'onDeck' })).toBe(`${TASKS}<h3>On deck</h3><ul class="todo-list"><li>NEW</li></ul>`);
  });

  it('leaves the template placeholder for the first committed task', () => {
    const template = '<h2>☑️ Tasks</h2><ul><li>[…]</li></ul>';
    expect(placeTask(template, '<li>NEW</li>', { kind: 'onDeck' })).toContain('<li>[…]</li>');
  });

  it('puts a new header, a forwarded task and an evening task above On deck, never into it', () => {
    const html = DECK + SUGGESTED;
    expect(placeTask(html, '<li>NEW</li>', { kind: 'section', name: 'Home' })).toMatch(/^<h2>Home<\/h2><ul class="todo-list"><li>NEW<\/li><\/ul><h3>On deck<\/h3>/);
    expect(placeForwarded(html, '<li>NEW</li>', null)).toMatch(/^<h2>☑️ Tasks<\/h2><ul class="todo-list"><li>NEW<\/li><\/ul><h3>On deck<\/h3>/);
    expect(placeForwarded(html, '<li>NEW</li>', 'Evening')).toMatch(/^<h3>Evening<\/h3><ul class="todo-list"><li>NEW<\/li><\/ul><h3>On deck<\/h3>/);
    expect(placeInMainList(TASKS + DECK, '<li>NEW</li>')).toContain('Write the spec ~1h</span></label></li><li>NEW</li></ul><h3>On deck</h3>');
  });

  it('puts a task committed to a day with only an evening and On deck in a new Tasks list above the evening, never under it', () => {
    const html = `<h3>Evening</h3>${ul(li('e1', 'Laundry'))}` + DECK;
    expect(placeInMainList(html, '<li>NEW</li>')).toMatch(/^<h2>☑️ Tasks<\/h2><ul class="todo-list"><li>NEW<\/li><\/ul><h3>Evening<\/h3>/);
    expect(placeForwarded(html, '<li>NEW</li>', null)).toMatch(/^<h2>☑️ Tasks<\/h2><ul class="todo-list"><li>NEW<\/li><\/ul><h3>Evening<\/h3>/);
  });

  it('puts a task into an empty main Tasks heading rather than a second one', () => {
    const html = `<h2>☑️ Tasks</h2><h3>Evening</h3>${ul(li('e1', 'Laundry'))}`;
    expect(placeForwarded(html, '<li>NEW</li>', null)).toBe(`<h2>☑️ Tasks</h2><ul class="todo-list"><li>NEW</li></ul><h3>Evening</h3>${ul(li('e1', 'Laundry'))}`);
  });

  it('takes an item off the deck unchanged, and the heading with the last one', () => {
    const one = TASKS + `<h3>On deck</h3>${ul(li('d1', 'Tidy the garage'))}` + SUGGESTED;
    const taken = takeOnDeck(one, 'd1', DEFAULT_STATE_SYMBOLS);
    expect(taken).toMatchObject({ ok: true, html: TASKS + SUGGESTED });
    expect(taken.ok && taken.markup).toBe(li('d1', 'Tidy the garage'));
    expect(takeOnDeck(one, 't1', DEFAULT_STATE_SYMBOLS)).toEqual({ ok: false, reason: 'not_on_deck' });
  });
});

describe('writing On deck', () => {
  it('adds a task to a day\'s On deck, and refuses On deck for a week', async () => {
    const fake = fakeTrilium(day('a', '2026-11-06', TASKS + SUGGESTED));
    const [added] = await addTasks(fake.api, [{ date: '2026-11-06', onDeck: true, text: 'Call the bank', est: '15m' }], { now: NOW });
    expect(added).toMatchObject({ status: 'added' });
    const plan = await readPlan(fake.api, 'day', '2026-11-06', NOW);
    expect(texts(plan.onDeck)).toEqual(['Call the bank']);
    const [week] = await addTasks(fake.api, [{ week: '2026-W45', onDeck: true, text: 'Nope' }], { now: NOW });
    expect(week).toMatchObject({ status: 'skipped', reason: 'bad_request' });
  });

  it('forwards to a day\'s On deck or its list as asked, and keeps an On deck task on deck by default', async () => {
    const fake = fakeTrilium({
      ...day('a', '2026-11-06', TASKS + DECK + SUGGESTED),
      ...day('b', '2026-11-09', `<h2>☑️ Tasks</h2>${ul(li('b1', 'Standing task'))}<h3>Suggested</h3>`),
      w: [periodNote('w', 'weekNote', '2026-W46'), `<h2>Week</h2>${ul(li('w1', 'Week thing'))}`],
    });
    const results = await forwardTasks(fake.api, [
      { noteId: 'a', listItemId: 't1', to: '2026-11-09', onDeck: true },
      { noteId: 'a', listItemId: 'd1', to: '2026-11-09' },
      { noteId: 'a', listItemId: 'd2', to: '2026-W46' },
    ]);
    expect(results.map((r) => r.status)).toEqual(['moved', 'moved', 'moved']);
    const monday = await readPlan(fake.api, 'day', '2026-11-09', NOW);
    expect(texts(monday.onDeck)).toEqual(['Write the spec', 'Tidy the garage']);
    expect(texts(monday.sections.flatMap((s) => s.tasks))).toEqual(['Standing task']);
    expect(fake.html.b!.indexOf('On deck')).toBeLessThan(fake.html.b!.indexOf('Suggested'));
    const week = await readPlan(fake.api, 'week', '2026-W46', NOW);
    expect(texts(week.sections.flatMap((s) => s.tasks))).toEqual(['Week thing', 'Read the RFC']);
    expect(week.onDeck).toEqual([]);

    const [refused] = await forwardTasks(fake.api, [{ noteId: 'b', listItemId: 'b1', to: '2026-W46', onDeck: true }]);
    expect(refused).toMatchObject({ status: 'skipped', reason: 'bad_request' });
  });

  it('forwards an On deck task to the list proper with onDeck false, or into the Important block', async () => {
    const fake = fakeTrilium({
      ...day('a', '2026-11-06', TASKS + DECK),
      ...day('b', '2026-11-09', `<h2>☑️ Tasks</h2>${ul(li('b1', 'Standing task'))}<h3>On deck</h3>${ul(li('b2', 'Maybe'))}`),
    });
    await forwardTasks(fake.api, [
      { noteId: 'a', listItemId: 'd1', to: '2026-11-09', onDeck: false },
      { noteId: 'a', listItemId: 'd2', to: '2026-11-09', critical: true },
    ]);
    const monday = await readPlan(fake.api, 'day', '2026-11-09', NOW);
    expect(texts(monday.sections.flatMap((s) => s.tasks))).toEqual(['Standing task', 'Tidy the garage']);
    expect(texts(monday.critical)).toEqual(['Read the RFC']);
    expect(texts(monday.onDeck)).toEqual(['Maybe']);
  });

  it('puts an On deck task on the list at a place, the same item, and a re-run changes nothing', async () => {
    const fake = fakeTrilium(day('a', '2026-11-06', `<h2>☑️ Tasks</h2>${ul(li('t1', 'First'), li('t2', 'Second'))}` + DECK + SUGGESTED));
    const results = await commitTasks(fake.api, [
      { noteId: 'a', listItemId: 'd1', after: 't1' },
      { noteId: 'a', listItemId: 'd2', critical: true },
    ]);
    expect(results.map((r) => r.status)).toEqual(['moved', 'moved']);
    const plan = await readPlan(fake.api, 'day', '2026-11-06', NOW);
    expect(texts(plan.sections.flatMap((s) => s.tasks))).toEqual(['First', 'Tidy the garage', 'Second']);
    expect(plan.sections.flatMap((s) => s.tasks).map((t) => t.listItemId)).toEqual(['t1', 'd1', 't2']);
    expect(texts(plan.critical)).toEqual(['Read the RFC']);
    expect(plan.onDeck).toEqual([]);
    expect(fake.html.a!).not.toContain('On deck');
    const again = await commitTasks(fake.api, [{ noteId: 'a', listItemId: 'd1', after: 't1' }]);
    expect(again[0]).toMatchObject({ status: 'unchanged' });
  });
});
