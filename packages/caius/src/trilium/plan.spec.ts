import { describe, it, expect } from 'vitest';
import { acceptTasks, addTasks, dismissTasks, EVENING_REASON, moveTasks, setStates } from './plan.js';
import { parseSource, taskKeys, textHash } from './keys.js';
import { readPlan } from './plan-read.js';
import { fakeTrilium, li, periodNote, STATES, TEMPLATE, ul } from './helpers.js';

const now = new Date(2026, 9, 26);
let n = 0;
const base = { states: STATES, newId: () => `enew${++n}`, now };
const DAY = '2026-10-26';

const seed = (html: string, extra: Record<string, [ReturnType<typeof periodNote>, string]> = {}) => ({
  d: [periodNote('d', 'dateNote', DAY), html] as [ReturnType<typeof periodNote>, string],
  ...extra,
});
const puts = (log: string[]) => log.filter((l) => l.startsWith('put') || l.startsWith('label') || l.startsWith('create'));

describe('keys', () => {
  it('finds Jira keys in text and browse urls, and falls back to a text hash', () => {
    expect(taskKeys('Review ZAP-12 feedback', [])).toEqual(['ZAP-12']);
    expect(taskKeys('x', ['https://zeroedin.atlassian.net/browse/SUR-5/', 'https://m.example/a#f'])).toEqual(['SUR-5', 'https://zeroedin.atlassian.net/browse/SUR-5', 'https://m.example/a']);
    expect(taskKeys('Fix UTF-8 bug', [])).toEqual([textHash('Fix UTF-8 bug')]);
    expect(textHash('Call  the Plumber! ~30m')).toBe(textHash('call the plumber'));
  });
  it('parses sources', () => {
    expect(parseSource('ZAP-1')).toMatchObject({ url: 'https://zeroedin.atlassian.net/browse/ZAP-1', label: 'ZAP-1', jira: 'ZAP-1' });
    expect(parseSource('https://mail.example/t/1')).toMatchObject({ label: 'mail.example', jira: null });
    expect(parseSource('not a source')).toBeNull();
  });
});

describe('addTasks', () => {
  it('adds under a header, writes the source as a link and the estimate last, and guards the write', async () => {
    const f = fakeTrilium(seed('<h3>Work</h3>' + ul(li('e1', 'Existing'))));
    const [r] = await addTasks(f.api, [{ date: DAY, section: 'Work', text: 'Reply to Pat', source: 'ZAP-7', est: '30m' }], base);
    expect(r).toMatchObject({ status: 'added', writtenNoteId: 'd', key: 'ZAP-7' });
    expect(f.html.d).toContain('Reply to Pat <a href="https://zeroedin.atlassian.net/browse/ZAP-7">ZAP-7</a> ~30m</span>');
    expect(puts(f.log)).toEqual(['put d']);
  });
  it('turns a Jira key already in the text into the link', async () => {
    const f = fakeTrilium(seed('<h3>Work</h3>'));
    await addTasks(f.api, [{ date: DAY, section: 'Work', text: 'Look at ZAP-7 today', source: 'ZAP-7' }], base);
    expect(f.html.d).toContain('Look at <a href="https://zeroedin.atlassian.net/browse/ZAP-7">ZAP-7</a> today');
  });
  it('puts the source link before tokens already in the text, and the estimate stays last', async () => {
    const f = fakeTrilium(seed('<h3>Work</h3>'));
    await addTasks(f.api, [{ date: DAY, section: 'Work', text: 'Plan it ~45m !!', source: 'https://m.example/x' }, { date: DAY, section: 'Work', text: 'Other !', source: 'ZAP-8', est: '20m' }], base);
    expect(f.html.d).toContain('Plan it <a href="https://m.example/x">m.example</a> ~45m !!</span>');
    expect(f.html.d).toContain('Other <a href="https://zeroedin.atlassian.net/browse/ZAP-8">ZAP-8</a> ! ~20m</span>');
  });
  it('is read back with its estimate and importance (tokens trailing after the link)', async () => {
    const f = fakeTrilium(seed('<h3>Work</h3>'));
    await addTasks(f.api, [{ date: DAY, section: 'Work', text: 'Plan it !', source: 'ZAP-8', est: '20m' }], base);
    const v = await readPlan(f.api, 'day', DAY, now);
    expect(v.sections[0]!.tasks[0]).toMatchObject({ estMinutes: 20 });
  });
  it('escapes text', async () => {
    const f = fakeTrilium(seed('<h3>Work</h3>'));
    await addTasks(f.api, [{ date: DAY, section: 'Work', text: 'a <b> & c' }], base);
    expect(f.html.d).toContain('a &lt;b&gt; &amp; c');
  });
  it('replaces the template placeholder on an untouched day', async () => {
    const f = fakeTrilium(seed(TEMPLATE));
    await addTasks(f.api, [{ date: DAY, section: 'Morning', text: 'First' }], base);
    expect(f.html.d).not.toContain('[…]');
    expect(f.html.d).toContain('<h3>Morning</h3>');
  });
  it('creates a missing day from the template, then writes into it; a dry run never creates', async () => {
    const dry = fakeTrilium(seed(''));
    const [d] = await addTasks(dry.api, [{ date: '2026-10-27', section: 'Work', text: 'Tomorrow' }], { ...base, dryRun: true });
    expect(d).toMatchObject({ status: 'added', dryRun: true, writtenNoteId: 'NEW-NOTE' });
    expect(puts(dry.log)).toEqual([]);

    const f = fakeTrilium(seed(''));
    const [r] = await addTasks(f.api, [{ date: '2026-10-27', section: 'Work', text: 'Tomorrow' }], base);
    expect(r).toMatchObject({ status: 'added', writtenNoteId: 'new-2026-10-27', detail: 'created the day note' });
    expect(puts(f.log)).toEqual(['create dateNote=2026-10-27', 'put new-2026-10-27']);
    expect(f.html['new-2026-10-27']).not.toContain('[…]');
  });
  it('does not create the day for a duplicate', async () => {
    const f = fakeTrilium(seed('<h3>Work</h3>' + ul(li('e1', 'Do ZAP-3'))));
    const [r] = await addTasks(f.api, [{ date: '2026-10-27', section: 'Work', text: 'Again', source: 'ZAP-3' }], base);
    expect(r).toMatchObject({ status: 'skipped', reason: 'duplicate' });
    expect(puts(f.log)).toEqual([]);
  });
  it('adds a week and a month note entry, creating them when missing', async () => {
    const f = fakeTrilium(seed(''));
    await addTasks(f.api, [{ week: '2026-W45', critical: true, text: 'Big' }, { month: '2026-11', suggested: true, text: 'Maybe' }], base);
    expect(f.html['new-2026-W45']).toContain('<aside class="admonition important">');
    expect(f.html['new-2026-11']).toContain('<h2>Suggested</h2>');
    expect(puts(f.log)).toEqual(['create weekNote=2026-W45', 'put new-2026-W45', 'create monthNote=2026-11', 'put new-2026-11']);
  });

  describe('dedupe', () => {
    const journal = {
      other: [periodNote('other', 'dateNote', '2026-10-20'), '<h3>Work</h3>' + ul(li('eo1', 'Check <a href="https://zeroedin.atlassian.net/browse/ZAP-1">ZAP-1</a>'), li('eo2', 'Read <a href="https://mail.example/t/9">the thread</a>'), li('eo3', 'Finished ZAP-2', { checked: true }), li('eo4', 'Plain words only'))] as [ReturnType<typeof periodNote>, string],
    };
    const run = async (req: Parameters<typeof addTasks>[1][number], more = {}) => {
      const f = fakeTrilium(seed('<h3>Work</h3>', { ...journal, ...more }));
      const [r] = await addTasks(f.api, [req], base);
      return { r, f };
    };
    it('skips a live task elsewhere with the same Jira key', async () => {
      const { r, f } = await run({ date: DAY, section: 'Work', text: 'x', source: 'ZAP-1' });
      expect(r).toMatchObject({ status: 'skipped', reason: 'duplicate' });
      expect(puts(f.log)).toEqual([]);
    });
    it('skips the same source URL, ignoring fragments and trailing slashes', async () => {
      expect((await run({ date: DAY, section: 'Work', text: 'x', source: 'https://mail.example/t/9/#frag' })).r).toMatchObject({ reason: 'duplicate' });
    });
    it('skips the same plain text when there is no key', async () => {
      expect((await run({ date: DAY, section: 'Work', text: 'plain  WORDS only ~15m' })).r).toMatchObject({ reason: 'duplicate' });
    });
    it('does not count a finished task', async () => {
      expect((await run({ date: DAY, section: 'Work', text: 'x', source: 'ZAP-2' })).r.status).toBe('added');
    });
    it('is idempotent: adding the same source twice writes once', async () => {
      const f = fakeTrilium(seed('<h3>Work</h3>'));
      const reqs = [{ date: DAY, section: 'Work', text: 'A', source: 'ZAP-50' }, { date: DAY, section: 'Work', text: 'A again', source: 'ZAP-50' }];
      const out = await addTasks(f.api, reqs, base);
      expect(out.map((o) => o.status)).toEqual(['added', 'skipped']);
      expect(puts(f.log)).toEqual(['put d']);
      const second = await addTasks(f.api, [reqs[0]!], base);
      expect(second[0]).toMatchObject({ reason: 'duplicate' });
    });
    it('skips a key already suggested on the same note', async () => {
      const f = fakeTrilium(seed('<h2>Suggested</h2>' + ul(li('es', 'Maybe ZAP-60'))));
      expect((await addTasks(f.api, [{ date: DAY, section: 'Work', text: 'x', source: 'ZAP-60' }], base))[0]).toMatchObject({ reason: 'duplicate' });
    });
    it('skips a key dismissed on that note, but not on another note', async () => {
      const dismissed = periodNote('d', 'dateNote', DAY, { attributes: [{ type: 'label', name: 'dateNote', value: DAY }, { type: 'label', name: 'caiusDismissed', value: 'ZAP-70' }] });
      const f = fakeTrilium({ d: [dismissed, '<h3>Work</h3>'], e: [periodNote('e', 'dateNote', '2026-10-27'), '<h3>Work</h3>'] });
      const [a, b] = await addTasks(f.api, [{ date: DAY, suggested: true, text: 'x', source: 'ZAP-70' }, { date: '2026-10-27', suggested: true, text: 'x', source: 'ZAP-70' }], base);
      expect(a).toMatchObject({ status: 'skipped', reason: 'dismissed' });
      expect(b.status).toBe('added');
    });
  });

  it('skips when the note changed between the read and the write (edit guard)', async () => {
    const f = fakeTrilium(seed('<h3>Work</h3>'), { onPut: (id) => (f.html[id] += '<p>edited elsewhere</p>') });
    const [r] = await addTasks(f.api, [{ date: DAY, section: 'Work', text: 'X' }], base);
    expect(r).toMatchObject({ status: 'skipped', reason: 'edited' });
    expect(puts(f.log)).toEqual([]);
  });

  it('dry run writes nothing and reports before/after', async () => {
    const f = fakeTrilium(seed('<h3>Work</h3>'));
    const [r] = await addTasks(f.api, [{ date: DAY, section: 'Work', text: 'X' }], { ...base, dryRun: true });
    expect(r).toMatchObject({ status: 'added', dryRun: true });
    expect((r as { changes: { before: string; after: string }[] }).changes[0]!.after).toContain('X');
    expect(puts(f.log)).toEqual([]);
  });

  it('rejects bad requests', async () => {
    const f = fakeTrilium(seed(''));
    const bad = [
      { date: DAY, text: 'x' },
      { date: DAY, section: 'W', critical: true, text: 'x' },
      { section: 'W', text: 'x' },
      { date: 'tomorrow', section: 'W', text: 'x' },
      { date: DAY, section: 'W', text: '  ' },
      { date: DAY, section: 'W', text: 'x', est: 'soon' },
      { date: DAY, section: 'W', text: 'x', source: 'nope' },
    ];
    const out = await addTasks(f.api, bad, base);
    expect(out.every((o) => o.status === 'skipped' && o.reason === 'bad_request')).toBe(true);
  });

  it("rejects a day, week or month that doesn't exist, and creates nothing", async () => {
    const f = fakeTrilium(seed(''));
    const bad = [{ date: '2026-02-30' }, { week: '2025-W53' }, { month: '2026-13' }].map((when) => ({ ...when, section: 'W', text: 'x' }));
    const out = await addTasks(f.api, bad, base);
    expect(out.map((o) => (o.status === 'skipped' ? o.reason : o.status))).toEqual(['bad_request', 'bad_request', 'bad_request']);
    expect(puts(f.log)).toEqual([]);
  });
});

describe('moveTasks', () => {
  const day = '<h2>☑️ Tasks</h2>' + ul(li('e1', 'One'), li('e2', 'Two'), li('e3', 'Three')) + '<h3>Evening</h3>' + ul(li('ev1', 'Laundry')) + '<h2>Suggested</h2>' + ul(li('es1', 'Maybe'));
  const order = (html: string | undefined) => [...(html ?? '').matchAll(/data-list-item-id="(\w+)"/g)].map((m) => m[1]);

  it('puts an item of his main list first, before or after another one, in the order named', async () => {
    const f = fakeTrilium(seed(day));
    const out = await moveTasks(f.api, [{ noteId: 'd', listItemId: 'e3', first: true }, { noteId: 'd', listItemId: 'e1', after: 'e2' }], base);
    expect(out.map((r) => r.status)).toEqual(['moved', 'moved']);
    expect(order(f.html.d)).toEqual(['e3', 'e2', 'e1', 'ev1', 'es1']);
    await moveTasks(f.api, [{ noteId: 'd', listItemId: 'e1', before: 'e3' }], base);
    expect(order(f.html.d)).toEqual(['e1', 'e3', 'e2', 'ev1', 'es1']);
  });
  it('is unchanged when the item is already there, and skips an item or an anchor outside his main list', async () => {
    const f = fakeTrilium(seed(day));
    const out = await moveTasks(f.api, [
      { noteId: 'd', listItemId: 'e1', first: true },
      { noteId: 'd', listItemId: 'ev1', first: true },
      { noteId: 'd', listItemId: 'e2', before: 'es1' },
      { noteId: 'd', listItemId: 'e2', after: 'e2' },
      { noteId: 'd', listItemId: 'e2' },
    ], base);
    expect(out.map((r) => [r.status, 'reason' in r ? r.reason : undefined])).toEqual([
      ['unchanged', undefined], ['skipped', 'not_in_main_list'], ['skipped', 'not_in_main_list'], ['skipped', 'bad_request'], ['skipped', 'bad_request'],
    ]);
    expect(f.html.d).toBe(day);
  });
});

describe('acceptTasks', () => {
  const html = '<h3>Work</h3>' + ul(li('e1', 'One'), li('e2', 'Two')) + '<h2>Suggested</h2>' + ul(li('es1', 'Maybe A'), li('es2', 'Maybe B'));

  it('moves a Suggested item to the end of a section, or to a position, or into critical', async () => {
    const f = fakeTrilium(seed(html));
    await acceptTasks(f.api, [{ noteId: 'd', listItemId: 'es1', section: 'Work' }, { noteId: 'd', listItemId: 'es2', section: 'Work', position: 1 }], base);
    const order = [...f.html.d!.matchAll(/data-list-item-id="(\w+)"/g)].map((m) => m[1]);
    expect(order).toEqual(['es2', 'e1', 'e2', 'es1']);
    // The last accept empties Suggested, so its heading goes too.
    expect(f.html.d).not.toContain('Suggested');
    const g = fakeTrilium(seed(html));
    await acceptTasks(g.api, [{ noteId: 'd', listItemId: 'es1', critical: true }], base);
    expect(g.html.d!.startsWith('<aside class="admonition important">')).toBe(true);
    expect(g.html.d).toContain('Maybe A');
  });
  it('without a section, appends to his main list in the order named, and adds no heading', async () => {
    const day = '<h3>Meetings</h3><ul><li>10:00 Standup</li></ul><h2>☑️ Tasks</h2>' + ul(li('e1', 'One'), li('e2', 'Two')) + '<h2>Suggested</h2>' + ul(li('es1', 'Maybe A'), li('es2', 'Maybe B'));
    const f = fakeTrilium(seed(day));
    const out = await acceptTasks(f.api, [{ noteId: 'd', listItemId: 'es2' }, { noteId: 'd', listItemId: 'es1' }], base);
    expect(out.map((r) => r.status)).toEqual(['accepted', 'accepted']);
    expect([...f.html.d!.matchAll(/data-list-item-id="(\w+)"/g)].map((m) => m[1])).toEqual(['e1', 'e2', 'es2', 'es1']);
    expect(f.html.d?.match(/<h\d>[^<]*/g)).toEqual(['<h3>Meetings', '<h2>☑️ Tasks']);
  });
  it('without a section, skips an Evening list and goes straight under the Tasks heading, creating its list', async () => {
    const day = '<h2>☑️ Tasks</h2><h3>Evening</h3>' + ul(li('ev1', 'Laundry')) + '<h2>Suggested</h2>' + ul(li('es9', 'Get ZAP-9 Fix it done: because x (~45m)'));
    const f = fakeTrilium(seed(day));
    expect((await acceptTasks(f.api, [{ noteId: 'd', listItemId: 'es9' }], base))[0]).toMatchObject({ status: 'accepted' });
    expect(f.html.d!.startsWith('<h2>☑️ Tasks</h2><ul class="todo-list"><li data-list-item-id="es9">')).toBe(true);
    const plan = await readPlan(f.api, 'day', DAY, now);
    expect(plan.sections.map((s) => [s.name, s.tasks.map((t) => t.text)])).toEqual([['☑️ Tasks', ['ZAP-9 Fix it']], ['Evening', ['Laundry']]]);
  });
  it('without a section, puts an evening suggestion under the evening heading, made above Suggested when there is none', async () => {
    const line = `Something away from screens, a chore or a Recharge item: because ${EVENING_REASON} (~45m)`;
    const day = '<h2>☑️ Tasks</h2>' + ul(li('e1', 'One')) + '<h3>Recharge</h3>' + ul(li('ev1', 'Read')) + '<h2>Suggested</h2>' + ul(li('es1', line));
    const f = fakeTrilium(seed(day));
    expect((await acceptTasks(f.api, [{ noteId: 'd', listItemId: 'es1' }], base))[0]).toMatchObject({ status: 'accepted' });
    const plan = await readPlan(f.api, 'day', DAY, now);
    expect(plan.sections.map((s) => [s.name, s.tasks.map((t) => [t.text, t.estMinutes])])).toEqual([
      ['☑️ Tasks', [['One', null]]], ['Recharge', [['Read', null], ['Something away from screens, a chore or a Recharge item', 45]]],
    ]);
    expect(plan.capacity.totalMinutes).toBe(30);
    const g = fakeTrilium(seed('<h2>☑️ Tasks</h2>' + ul(li('e1', 'One')) + '<h2>Suggested</h2>' + ul(li('es1', line), li('es2', 'Maybe B'))));
    await acceptTasks(g.api, [{ noteId: 'd', listItemId: 'es1' }], base);
    expect(g.html.d).toMatch(/<h2>☑️ Tasks<\/h2><ul[^>]*><li data-list-item-id="e1">.*<h\d>Evening<\/h\d><ul[^>]*><li data-list-item-id="es1">.*<h2>Suggested<\/h2>/s);
  });
  it('turns an accepted suggestion into a plain task: its key link and title, then its estimate as a token', async () => {
    const link = '<a href="https://zeroedin.atlassian.net/browse/ZAP-111">ZAP-111</a>';
    const day = '<h2>☑️ Tasks</h2>' + ul(li('e1', 'One')) + '<h2>Suggested</h2>' + ul(
      li('es1', `Get ${link} Check the invoice export in QA done: because sitting in QA Testing for 3 days (~45m)`),
      li('es2', 'Get Book the venue done: because the quote expires Friday (~15m)'),
    );
    const f = fakeTrilium(seed(day));
    await acceptTasks(f.api, [{ noteId: 'd', listItemId: 'es1' }, { noteId: 'd', listItemId: 'es2' }], base);
    expect(f.html.d).toContain(`<span class="todo-list__label__description">${link} Check the invoice export in QA ~45m</span>`);
    expect(f.html.d).toContain('<span class="todo-list__label__description">Book the venue ~15m</span>');
    const plan = await readPlan(f.api, 'day', DAY, now);
    expect(plan.sections[0]!.tasks.map((t) => [t.text, t.estMinutes])).toEqual([
      ['One', null],
      [`[ZAP-111](https://zeroedin.atlassian.net/browse/ZAP-111) Check the invoice export in QA`, 45],
      ['Book the venue', 15],
    ]);
  });
  it("turns an accepted ask into a plain task: 'Answer X's question on KEY: because Y (~15m)' keeps its words and its estimate as a token", async () => {
    const link = '<a href="https://zeroedin.atlassian.net/browse/ZAP-105">ZAP-105</a>';
    const day = '<h2>☑️ Tasks</h2>' + ul(li('e1', 'One')) + '<h2>Suggested</h2>' + ul(
      li('es1', `Answer Jordan Placeholder's question on ${link}: because Jordan Placeholder asked on Sunday (~15m)`),
    );
    const f = fakeTrilium(seed(day));
    await acceptTasks(f.api, [{ noteId: 'd', listItemId: 'es1' }], base);
    expect(f.html.d).toContain(`<span class="todo-list__label__description">Answer Jordan Placeholder's question on ${link} ~15m</span>`);
    const plan = await readPlan(f.api, 'day', DAY, now);
    expect(plan.sections[0]?.tasks.map((t) => t.estMinutes)).toEqual([null, 15]);
  });
  it('unwraps a suggestion that CKEditor saved with non-breaking spaces', async () => {
    const link = '<a href="https://zeroedin.atlassian.net/browse/ZAP-2">ZAP-2</a>';
    const day = '<h2>☑️ Tasks</h2>' + ul(li('e1', 'One')) + '<h2>Suggested</h2>' + ul(
      li('es1', `Get&nbsp;${link} Fix done:&nbsp;because it waits (~30m)`),
      li('es2', 'Get Book the venue done: because it waits (~15m)&nbsp;'),
    );
    const f = fakeTrilium(seed(day));
    await acceptTasks(f.api, [{ noteId: 'd', listItemId: 'es1' }, { noteId: 'd', listItemId: 'es2' }], base);
    expect(f.html.d).toContain(`<span class="todo-list__label__description">${link} Fix ~30m</span>`);
    expect(f.html.d).toContain('<span class="todo-list__label__description">Book the venue ~15m</span>');
  });
  it('keeps Suggested last when accepting into a new section', async () => {
    const f = fakeTrilium(seed(html));
    await acceptTasks(f.api, [{ noteId: 'd', listItemId: 'es1', section: 'Home' }], base);
    expect(f.html.d!.indexOf('<h3>Home</h3>')).toBeLessThan(f.html.d!.indexOf('<h2>Suggested</h2>'));
  });
  it('refuses an item that is not under Suggested, and is idempotent', async () => {
    const f = fakeTrilium(seed(html));
    expect((await acceptTasks(f.api, [{ noteId: 'd', listItemId: 'e1', section: 'Work' }], base))[0]).toMatchObject({ reason: 'not_suggested' });
    await acceptTasks(f.api, [{ noteId: 'd', listItemId: 'es1', section: 'Work' }], base);
    expect((await acceptTasks(f.api, [{ noteId: 'd', listItemId: 'es1', section: 'Work' }], base))[0]).toMatchObject({ status: 'skipped', reason: 'not_suggested' });
    expect(puts(f.log)).toEqual(['put d']);
  });
  it('dry run and guard', async () => {
    const f = fakeTrilium(seed(html));
    const [r] = await acceptTasks(f.api, [{ noteId: 'd', listItemId: 'es1', section: 'Work' }], { ...base, dryRun: true });
    expect(r.status).toBe('accepted');
    expect(puts(f.log)).toEqual([]);
    const put = f.api.putContent;
    f.api.putContent = async (id, body, expected) => { f.html.d += '<p>x</p>'; return put(id, body, expected); };
    expect((await acceptTasks(f.api, [{ noteId: 'd', listItemId: 'es1', section: 'Work' }], base))[0]).toMatchObject({ reason: 'edited' });
  });
  it('rejects bad requests', async () => {
    const f = fakeTrilium(seed(html));
    const out = await acceptTasks(f.api, [{ noteId: 'd', listItemId: 'es1', section: 'W', critical: true }, { noteId: 'd', listItemId: 'es1', section: 'W', position: 0 }, { noteId: '', listItemId: 'x', critical: true }], base);
    expect(out.every((o) => o.status === 'skipped' && o.reason === 'bad_request')).toBe(true);
  });
});

describe('dismissTasks', () => {
  const html = '<h3>Work</h3>' + ul(li('e1', 'One')) + '<h2>Suggested</h2>' + ul(li('es1', 'Look at <a href="https://zeroedin.atlassian.net/browse/ZAP-9">ZAP-9</a>'), li('es2', 'No key here'));

  it('removes the item and labels the note with its source key; text-only items use a hash', async () => {
    const f = fakeTrilium(seed(html));
    const out = await dismissTasks(f.api, [{ noteId: 'd', listItemId: 'es1' }, { noteId: 'd', listItemId: 'es2' }], base);
    expect(out.map((o) => o.status)).toEqual(['dismissed', 'dismissed']);
    expect(f.log).toEqual(['label d caiusDismissed=ZAP-9', 'put d', `label d caiusDismissed=${textHash('No key here')}`, 'put d']);
    expect(f.html.d).not.toContain('ZAP-9');
  });
  it('then add refuses that key on the same note', async () => {
    const f = fakeTrilium(seed(html));
    await dismissTasks(f.api, [{ noteId: 'd', listItemId: 'es1' }], base);
    const [r] = await addTasks(f.api, [{ date: DAY, suggested: true, text: 'again', source: 'ZAP-9' }], base);
    expect(r).toMatchObject({ status: 'skipped', reason: 'dismissed' });
  });
  it('refuses anything not under Suggested, and a second run does nothing', async () => {
    const f = fakeTrilium(seed(html));
    expect((await dismissTasks(f.api, [{ noteId: 'd', listItemId: 'e1' }], base))[0]).toMatchObject({ reason: 'not_suggested' });
    await dismissTasks(f.api, [{ noteId: 'd', listItemId: 'es1' }], base);
    expect((await dismissTasks(f.api, [{ noteId: 'd', listItemId: 'es1' }], base))[0]).toMatchObject({ status: 'skipped' });
    expect(f.log.filter((l) => l.startsWith('label'))).toHaveLength(1);
  });
  it('dry run writes no label and no content; guard drops a changed note', async () => {
    const f = fakeTrilium(seed(html));
    const [r] = await dismissTasks(f.api, [{ noteId: 'd', listItemId: 'es1' }], { ...base, dryRun: true });
    expect(r).toMatchObject({ status: 'dismissed', dryRun: true, key: 'ZAP-9' });
    expect(f.log).toEqual([]);
    const content = f.api.content;
    let reads = 0;
    f.api.content = async (id) => { if (++reads === 2) f.html.d += '<p>x</p>'; return content(id); };
    expect((await dismissTasks(f.api, [{ noteId: 'd', listItemId: 'es1' }], base))[0]).toMatchObject({ reason: 'edited' });
    expect(f.log).toEqual([]);
  });
  it('reports a note edited after the label went on, and keeps the edit', async () => {
    const f = fakeTrilium(seed(html), { onPut: (id) => (f.html[id] += '<p>x</p>') });
    const [r] = await dismissTasks(f.api, [{ noteId: 'd', listItemId: 'es1' }], base);
    expect(r).toMatchObject({ status: 'skipped', reason: 'edited', detail: expect.stringContaining('re-run') });
    expect(f.log).toEqual(['label d caiusDismissed=ZAP-9']);
    expect(f.html.d).toContain('<p>x</p>');
  });
});

describe('done, start, drop', () => {
  const html = '<h3>Work</h3>' + ul(li('e1', 'One'), li('e2', 'Two'), li('e3', 'Three'));

  it('sets the three states and writes once each', async () => {
    const f = fakeTrilium(seed(html));
    await setStates(f.api, 'done', [{ noteId: 'd', listItemId: 'e1' }], base);
    await setStates(f.api, 'start', [{ noteId: 'd', listItemId: 'e2' }], base);
    const [r] = await setStates(f.api, 'drop', [{ noteId: 'd', listItemId: 'e3', reason: 'not needed' }], base);
    expect(r).toMatchObject({ status: 'updated', state: 'cancelled' });
    expect(f.html.d).toContain('<input type="checkbox" checked="checked" disabled="disabled"><span class="todo-list__label__description">One');
    expect(f.html.d).toContain('data-list-item-id="e2" data-trilium-task-state="doing" title="Doing"');
    expect(f.html.d).toContain('Three <em>not needed</em>');
    expect(puts(f.log)).toEqual(['put d', 'put d', 'put d']);
  });
  it('is idempotent', async () => {
    const f = fakeTrilium(seed(html));
    await setStates(f.api, 'done', [{ noteId: 'd', listItemId: 'e1' }], base);
    expect((await setStates(f.api, 'done', [{ noteId: 'd', listItemId: 'e1' }], base))[0]).toMatchObject({ reason: 'already_done' });
    expect(puts(f.log)).toEqual(['put d']);
  });
  it('reads the real state ids from the symbols', async () => {
    const f = fakeTrilium(seed(html));
    await setStates(f.api, 'start', [{ noteId: 'd', listItemId: 'e1' }], { ...base, states: new Map([['my-doing', '/']]) });
    expect(f.html.d).toContain('data-trilium-task-state="my-doing"');
  });
  it('drop needs a reason; dry run writes nothing; the guard drops a changed note', async () => {
    const f = fakeTrilium(seed(html));
    expect((await setStates(f.api, 'drop', [{ noteId: 'd', listItemId: 'e1' }], base))[0]).toMatchObject({ reason: 'bad_request' });
    const [r] = await setStates(f.api, 'done', [{ noteId: 'd', listItemId: 'e1' }], { ...base, dryRun: true });
    expect(r).toMatchObject({ status: 'updated', dryRun: true });
    expect(puts(f.log)).toEqual([]);
    const put = f.api.putContent;
    f.api.putContent = async (id, body, expected) => { f.html.d += '<p>x</p>'; return put(id, body, expected); };
    expect((await setStates(f.api, 'done', [{ noteId: 'd', listItemId: 'e1' }], base))[0]).toMatchObject({ reason: 'edited' });
  });
  it('reports a failed put without stopping the batch', async () => {
    const f = fakeTrilium(seed(html), { failPut: 'd' });
    const out = await setStates(f.api, 'done', [{ noteId: 'd', listItemId: 'e1' }, { noteId: 'd', listItemId: 'zz' }], base);
    expect(out.map((o) => o.status)).toEqual(['failed', 'skipped']);
  });
});
