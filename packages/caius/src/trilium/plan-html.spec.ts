import { describe, it, expect } from 'vitest';
import { parse } from 'node-html-parser';
import { moveInMainList, placeForwarded, placeInDay, placeInMainList, placeTask, setTaskArea, setTaskEstimate, setTaskState, takeSuggested, itemMarkup } from './plan-html.js';
import { critical, li, STATES, TEMPLATE, ul } from './helpers.js';

const item = itemMarkup('enew', 'New thing');
const ids = (html: string) => parse(html).querySelectorAll('li').map((l) => l.getAttribute('data-list-item-id'));

describe('placeTask', () => {
  it('replaces the template placeholder with the first task under a section', () => {
    const out = placeTask(TEMPLATE, item, { kind: 'section', name: 'Morning' });
    expect(out).not.toContain('[…]');
    expect(out).toBe(`<h2>☑️ Tasks</h2><h3>Morning</h3><ul class="todo-list">${item}</ul>`);
  });
  it('replaces the placeholder when the section is the template title itself', () => {
    expect(placeTask(TEMPLATE, item, { kind: 'section', name: 'Tasks' })).toBe(`<h2>☑️ Tasks</h2><ul class="todo-list">${item}</ul>`);
  });
  it('also replaces it for a critical task', () => {
    const out = placeTask(TEMPLATE, item, { kind: 'critical' });
    expect(out).toBe(`<aside class="admonition important"><ul class="todo-list">${item}</ul></aside><h2>☑️ Tasks</h2>`);
  });
  it('keeps the placeholder when only Suggested is being filled', () => {
    const out = placeTask(TEMPLATE, item, { kind: 'suggested' });
    expect(out).toBe(`${TEMPLATE}<h2>Suggested</h2><ul class="todo-list">${item}</ul>`);
  });
  it('leaves a leftover placeholder alone on a day that already has tasks', () => {
    const html = '<h3>Work</h3>' + ul(li('e1', 'Existing')) + '<ul><li>[…]</li></ul>';
    expect(placeTask(html, item, { kind: 'section', name: 'Work' })).toContain('[…]');
  });
  it('appends to the matching header ignoring case and emoji, or at a position', () => {
    const html = '<h3>🌅 Morning</h3>' + ul(li('e1', 'One'), li('e2', 'Two')) + '<h3>Evening</h3>' + ul(li('e3', 'Three'));
    expect(ids(placeTask(html, item, { kind: 'section', name: 'morning' }))).toEqual(['e1', 'e2', 'enew', 'e3']);
    expect(ids(placeTask(html, item, { kind: 'section', name: 'morning' }, 1))).toEqual(['enew', 'e1', 'e2', 'e3']);
    expect(ids(placeTask(html, item, { kind: 'section', name: 'morning' }, 2))).toEqual(['e1', 'enew', 'e2', 'e3']);
    expect(ids(placeTask(html, item, { kind: 'section', name: 'morning' }, 99))).toEqual(['e1', 'e2', 'enew', 'e3']);
  });
  it('creates a missing header above Suggested so Suggested stays last', () => {
    const html = '<h2>☑️ Tasks</h2><h3>Work</h3>' + ul(li('e1', 'One')) + '<h2>Suggested</h2>' + ul(li('es', 'Maybe'));
    const out = placeTask(html, item, { kind: 'section', name: 'Home' });
    expect(out.indexOf('<h3>Home</h3>')).toBeGreaterThan(out.indexOf('Work'));
    expect(out.indexOf('<h3>Home</h3>')).toBeLessThan(out.indexOf('<h2>Suggested</h2>'));
    expect(out.endsWith(ul(li('es', 'Maybe')))).toBe(true);
  });
  it('creates Suggested last, and adds into an existing one without moving it', () => {
    const html = '<h3>Work</h3>' + ul(li('e1', 'One'));
    const once = placeTask(html, item, { kind: 'suggested' });
    expect(once.endsWith(`<h2>Suggested</h2><ul class="todo-list">${item}</ul>`)).toBe(true);
    const twice = placeTask(once, itemMarkup('e2x', 'More'), { kind: 'suggested' });
    expect(ids(twice)).toEqual(['e1', 'enew', 'e2x']);
    const sections = placeTask(twice, itemMarkup('e3x', 'Late'), { kind: 'section', name: 'Later' });
    expect(sections.lastIndexOf('<h2>Suggested</h2>')).toBeGreaterThan(sections.indexOf('<h3>Later</h3>'));
  });
  it('uses the level in use for a new header', () => {
    const html = '<h2>A</h2>' + ul(li('e1', 'x')) + '<h3>B</h3>' + ul(li('e2', 'y'));
    expect(placeTask(html, item, { kind: 'section', name: 'C' })).toContain('<h3>C</h3>');
  });
  it('adds to an existing critical block, or creates one at the top', () => {
    const html = '<h2>T</h2>' + critical(li('ec', 'Crit'));
    expect(ids(placeTask(html, item, { kind: 'critical' }))).toEqual(['ec', 'enew']);
    expect(placeTask('<h2>T</h2>', item, { kind: 'critical' }).startsWith('<aside class="admonition important"><ul class="todo-list">')).toBe(true);
  });
  it('touches nothing else (byte-for-byte outside the insertion)', () => {
    const html = '<p>keep &amp; <b>me</b>  </p><h3>Work</h3>' + ul(li('e1', 'One &amp; two'));
    const out = placeTask(html, item, { kind: 'section', name: 'Work' });
    expect(out.replace(item, '')).toBe(html);
  });
});

describe('takeSuggested', () => {
  const html = '<h3>Work</h3>' + ul(li('e1', 'One')) + '<h2>Suggested</h2>' + ul(li('es1', 'Fix <a href="https://x.example/a#top">thing</a>'), li('es2', 'Other'));
  it('removes an item, keeping the rest and the heading, and reports its text and links', () => {
    const r = takeSuggested(html, 'es1');
    if (!r.ok) throw new Error('expected ok');
    expect(r.text).toBe('Fix thing');
    expect(r.hrefs).toEqual(['https://x.example/a#top']);
    expect(ids(r.html)).toEqual(['e1', 'es2']);
    expect(r.html).toContain('<h2>Suggested</h2>');
  });
  it('removes the whole list and the emptied Suggested heading when it was the last item', () => {
    const r = takeSuggested('<h3>Work</h3>' + ul(li('e1', 'One')) + '<h2>💡 Suggested</h2>' + ul(li('es1', 'Only')), 'es1');
    expect(r.ok && r.html).toBe('<h3>Work</h3>' + ul(li('e1', 'One')));
    const before = takeSuggested('<h2>Suggested</h2>' + ul(li('es1', 'Only')) + '<h2>Notes</h2><p>x</p>', 'es1');
    expect(before.ok && before.html).toBe('<h2>Notes</h2><p>x</p>');
  });
  it('keeps the heading when something else is still under it', () => {
    const prose = takeSuggested('<h2>Suggested</h2><p>From the brief</p>' + ul(li('es1', 'Only')), 'es1');
    expect(prose.ok && prose.html).toBe('<h2>Suggested</h2><p>From the brief</p>');
    const sub = takeSuggested('<h2>Suggested</h2>' + ul(li('es1', 'Only')) + '<h3>Ideas</h3>' + ul(li('es2', 'Later')), 'es1');
    expect(sub.ok && sub.html).toBe('<h2>Suggested</h2><h3>Ideas</h3>' + ul(li('es2', 'Later')));
  });
  it('refuses items outside Suggested and unknown ids', () => {
    expect(takeSuggested(html, 'e1')).toEqual({ ok: false, reason: 'not_suggested' });
    expect(takeSuggested(html, 'nope')).toEqual({ ok: false, reason: 'not_found' });
  });
  it('refuses a sub-item of a Suggested item', () => {
    const h = '<h2>Suggested</h2>' + ul(li('es1', 'Parent', { sub: ul(li('esub', 'Child')) }));
    expect(takeSuggested(h, 'esub')).toEqual({ ok: false, reason: 'not_suggested' });
  });
});

describe('setTaskState', () => {
  const o = { states: STATES };
  const html = '<h3>Work</h3>' + ul(li('eo', 'Open one'), li('ed', 'Underway', { state: 'doing' }), li('ex', 'Done', { checked: true }), li('ec', 'Gone', { state: 'cancelled', checked: true }));

  it('done: checks the box and clears any state attribute', () => {
    const a = setTaskState(html, 'eo', 'done', o);
    expect(a.ok && a.html).toContain('<li data-list-item-id="eo"><label class="todo-list__label"><input type="checkbox" checked="checked" disabled="disabled">');
    const b = setTaskState(html, 'ed', 'done', o);
    expect(b.ok && b.html).toContain('<li data-list-item-id="ed"><label class="todo-list__label"><input type="checkbox" checked="checked"');
    expect(b.ok && b.html.match(/data-trilium-task-state/g)).toHaveLength(1); // only the cancelled one is left
  });
  it('start: Doing state with its title, box unchecked', () => {
    const r = setTaskState(html, 'eo', 'start', o);
    expect(r.ok && r.html).toContain('<li data-list-item-id="eo" data-trilium-task-state="doing" title="Doing"><label class="todo-list__label"><input type="checkbox" disabled="disabled">');
  });
  it('drop: Cancelled, checked, with the reason as a trailing italic, and live sub-items cancelled too', () => {
    const h = ul(li('ep', 'Parent', { sub: ul(li('eka', 'Kid open'), li('ekb', 'Kid done', { checked: true })) }));
    const r = setTaskState(h, 'ep', 'drop', { ...o, reason: 'no longer <needed>' });
    if (!r.ok) throw new Error('expected ok');
    expect(r.html).toContain('Parent <em>no longer &lt;needed&gt;</em></span>');
    expect(r.html).toContain('<li data-list-item-id="ep" data-trilium-task-state="cancelled" title="Cancelled">');
    expect(r.html).toContain('<li data-list-item-id="eka" data-trilium-task-state="cancelled" title="Cancelled">');
    expect(r.html).toContain('<li data-list-item-id="ekb"><label'); // closed sub-item untouched
  });
  it('uses the state ids it is given', () => {
    const r = setTaskState(html, 'eo', 'start', { ...o, doingId: 'custom-doing' });
    expect(r.ok && r.html).toContain('data-trilium-task-state="custom-doing"');
  });
  it('is idempotent and refuses what is not live', () => {
    expect(setTaskState(html, 'ex', 'done', o)).toMatchObject({ ok: false, reason: 'already_done' });
    expect(setTaskState(html, 'ed', 'start', o)).toMatchObject({ ok: false, reason: 'already_doing' });
    expect(setTaskState(html, 'ec', 'drop', o)).toMatchObject({ ok: false, reason: 'already_cancelled' });
    expect(setTaskState(html, 'ex', 'drop', o)).toMatchObject({ ok: false, reason: 'not_live' });
    expect(setTaskState(html, 'ec', 'done', o)).toMatchObject({ ok: false, reason: 'not_live' });
    expect(setTaskState(html, 'ed', 'drop', { ...o, reason: 'x' }).ok).toBe(true);
    expect(setTaskState(html, 'zz', 'done', o)).toMatchObject({ ok: false, reason: 'not_found' });
  });
  it('touches nothing else', () => {
    const h = '<p>keep</p>' + ul(li('eo', 'Open one'), li('eq', 'Neighbour'));
    const r = setTaskState(h, 'eo', 'done', o);
    expect(r.ok && r.html).toBe(h.replace('<input type="checkbox" disabled', '<input type="checkbox" checked="checked" disabled'));
  });
});

describe('time blocks', () => {
  const sec = (name: string) => ({ kind: 'section' as const, name });
  const heads = (html: string) => parse(html).querySelectorAll('h1,h2,h3,h4').map((h) => h.text);

  it('makes a missing block between the others, Afternoon after Morning and before Evening', () => {
    const html = '<h2>☑️ Tasks</h2><h3>Morning</h3>' + ul(li('m1', 'A')) + '<h3>Evening</h3>' + ul(li('v1', 'B')) + '<h2>Suggested</h2>' + ul(li('s1', 'C'));
    const out = placeTask(html, item, sec('Afternoon'));
    expect(heads(out)).toEqual(['☑️ Tasks', 'Morning', 'Afternoon', 'Evening', 'Suggested']);
    expect(out).toContain(`<h3>Afternoon</h3><ul class="todo-list">${item}</ul><h3>Evening</h3>`);
  });
  it('makes Morning before the first later block, and a last block above On deck', () => {
    const html = '<h2>☑️ Tasks</h2><h3>Afternoon</h3>' + ul(li('a1', 'A')) + '<h3>On deck</h3>' + ul(li('d1', 'D'));
    expect(heads(placeTask(html, item, sec('Morning')))).toEqual(['☑️ Tasks', 'Morning', 'Afternoon', 'On deck']);
    expect(heads(placeTask(html, item, sec('Evening')))).toEqual(['☑️ Tasks', 'Afternoon', 'Evening', 'On deck']);
  });
  it('matches a block heading with an emoji, and writes a new one plainly', () => {
    const html = '<h2>☑️ Tasks</h2><h3>🌅 Morning</h3>' + ul(li('m1', 'A'));
    expect(ids(placeTask(html, item, sec('Morning')))).toEqual(['m1', 'enew']);
    expect(placeTask(html, item, sec('evening'))).toContain('<h3>Evening</h3>');
  });
});

describe('placeForwarded into blocks', () => {
  const note = '<h2>☑️ Tasks</h2><h3>Morning</h3>' + ul(li('m1', 'A')) + '<h3>Evening</h3>' + ul(li('v1', 'B')) + '<h2>Suggested</h2>' + ul(li('s1', 'C'));
  it('keeps an Evening task in the Evening block', () => {
    expect(ids(placeForwarded(note, item, 'Evening'))).toEqual(['m1', 'v1', 'enew', 's1']);
    expect(ids(placeForwarded(note, item, '🌙 Evening'))).toEqual(['m1', 'v1', 'enew', 's1']);
  });
  it('makes the block when the target lacks it, in order', () => {
    const out = placeForwarded(note, item, 'Afternoon');
    expect(out).toContain(`<h3>Afternoon</h3><ul class="todo-list">${item}</ul><h3>Evening</h3>`);
  });
  it('sends a legacy Recharge or Growth section the target lacks to its Evening block', () => {
    expect(ids(placeForwarded(note, item, 'Recharge'))).toEqual(['m1', 'v1', 'enew', 's1']);
    expect(ids(placeForwarded(note, item, 'Growth'))).toEqual(['m1', 'v1', 'enew', 's1']);
    const bare = '<h2>☑️ Tasks</h2><h3>Morning</h3>' + ul(li('m1', 'A'));
    expect(placeForwarded(bare, item, 'Recharge')).toBe(`${bare}<h3>Evening</h3><ul class="todo-list">${item}</ul>`);
  });
  it('puts a task with no section in the first work list, not in the evening', () => {
    expect(ids(placeForwarded(note, item, null))).toEqual(['m1', 'enew', 'v1', 's1']);
    const evening = '<h2>☑️ Tasks</h2><h3>Evening</h3>' + ul(li('v1', 'B'));
    expect(placeForwarded(evening, item, null)).toMatch(/^<h2>☑️ Tasks<\/h2><ul class="todo-list"><li[^>]*>.*<\/ul><h3>Evening<\/h3>/);
  });
});

describe('placeInMainList with blocks', () => {
  const note = '<h2>☑️ Tasks</h2><h3>Morning</h3>' + ul(li('m1', 'A')) + '<h3>Afternoon</h3>' + ul(li('a1', 'B')) + '<h3>Evening</h3>' + ul(li('v1', 'C'));
  it('places into the named block', () => {
    expect(ids(placeInMainList(note, item, 'afternoon'))).toEqual(['m1', 'a1', 'enew', 'v1']);
    expect(ids(placeInMainList(note, item, 'evening'))).toEqual(['m1', 'a1', 'v1', 'enew']);
  });
  it('without a block, goes to the end of the first block with a list, never a stray list under the heading', () => {
    const out = placeInMainList(note, item);
    expect(ids(out)).toEqual(['m1', 'enew', 'a1', 'v1']);
    expect(out.startsWith('<h2>☑️ Tasks</h2><h3>Morning</h3>')).toBe(true);
    const later = '<h2>☑️ Tasks</h2><h3>Morning</h3><h3>Afternoon</h3>' + ul(li('a1', 'B'));
    expect(ids(placeInMainList(later, item))).toEqual(['a1', 'enew']);
  });
  it('without a block or a list, makes Morning', () => {
    const empty = '<h2>☑️ Tasks</h2><h3>Morning</h3><h3>Evening</h3>' + ul(li('v1', 'C'));
    expect(placeInMainList(empty, item)).toBe(`<h2>☑️ Tasks</h2><h3>Morning</h3><ul class="todo-list">${item}</ul><h3>Evening</h3>${ul(li('v1', 'C'))}`);
    const bare = '<h2>☑️ Tasks</h2><h3>Evening</h3>' + ul(li('v1', 'C'));
    expect(placeInMainList(bare, item)).toBe(`<h2>☑️ Tasks</h2><ul class="todo-list">${item}</ul><h3>Evening</h3>${ul(li('v1', 'C'))}`);
  });
  it('keeps today\'s behaviour on a note without blocks', () => {
    const plain = '<h2>☑️ Tasks</h2>' + ul(li('e1', 'One')) + '<h2>Suggested</h2>' + ul(li('s1', 'x'));
    expect(ids(placeInMainList(plain, item))).toEqual(['e1', 'enew', 's1']);
  });
});

describe('moveInMainList in a block', () => {
  const note = '<h2>☑️ Tasks</h2><h3>Morning</h3>' + ul(li('m1', 'A'), li('m2', 'B'), li('m3', 'C')) + '<h3>Afternoon</h3>' + ul(li('a1', 'D'), li('a2', 'E'))
    + '<h3>On deck</h3>' + ul(li('d1', 'F'), li('d2', 'G'));
  const order = (html: string) => ids(html);
  it('moves within a block list, first meaning first of its own list', () => {
    const r = moveInMainList(note, 'a2', { first: true });
    expect(r).toMatchObject({ ok: true, unchanged: false });
    expect(r.ok && order(r.html)).toEqual(['m1', 'm2', 'm3', 'a2', 'a1', 'd1', 'd2']);
    const after = moveInMainList(note, 'm1', { after: 'm3' });
    expect(after.ok && order(after.html)).toEqual(['m2', 'm3', 'm1', 'a1', 'a2', 'd1', 'd2']);
    expect(moveInMainList(note, 'a1', { first: true })).toMatchObject({ ok: true, unchanged: true });
  });
  it('fails across lists, or in On deck', () => {
    expect(moveInMainList(note, 'm1', { before: 'a1' })).toEqual({ ok: false, reason: 'not_in_main_list' });
    expect(moveInMainList(note, 'd2', { first: true })).toEqual({ ok: false, reason: 'not_in_main_list' });
    expect(moveInMainList(note, 'zz', { first: true })).toEqual({ ok: false, reason: 'not_in_main_list' });
  });
  it('still moves in the list under the main heading', () => {
    const plain = '<h2>☑️ Tasks</h2>' + ul(li('e1', 'One'), li('e2', 'Two'));
    const r = moveInMainList(plain, 'e2', { first: true });
    expect(r.ok && order(r.html)).toEqual(['e2', 'e1']);
  });
});

describe('setTaskArea', () => {
  const note = '<h2>☑️ Tasks</h2>' + ul(
    li('t1', 'Write the spec ~1h'),
    li('t2', '🌱 Read a chapter', { sub: ul(li('t2a', 'Take notes')) }),
    li('t3', '<a href="https://example.com/x">Link</a> first ~30m'),
    li('t4', '🔋&nbsp;Walk 09:00'),
  ) + '<h2>Meetings</h2>' + ul(li('p1', 'Standup'));
  const text = (html: string, id: string) => parse(html).querySelectorAll('li').find((l) => l.getAttribute('data-list-item-id') === id)!.querySelector('span.todo-list__label__description')!.innerHTML;

  it('adds, replaces and removes the marker, touching only the first text', () => {
    const grown = setTaskArea(note, 't1', 'growth');
    expect(grown).toMatchObject({ ok: true, unchanged: false });
    expect(grown.ok && text(grown.html, 't1')).toBe('🌱 Write the spec ~1h');
    const moved = setTaskArea(note, 't2', 'recharge');
    expect(moved.ok && text(moved.html, 't2')).toBe('🔋 Read a chapter');
    expect(moved.ok && text(moved.html, 't2a')).toBe('Take notes');
    const bare = setTaskArea(note, 't2', 'foundation');
    expect(bare.ok && text(bare.html, 't2')).toBe('Read a chapter');
    expect(bare.ok && bare.html).toContain(ul(li('t2a', 'Take notes')));
  });
  it('keeps a leading link whole, and puts the marker before it', () => {
    const r = setTaskArea(note, 't3', 'growth');
    expect(r.ok && text(r.html, 't3')).toBe('🌱 <a href="https://example.com/x">Link</a> first ~30m');
    expect(setTaskArea(note, 't3', 'foundation')).toMatchObject({ ok: true, unchanged: true });
  });
  it('replaces a marker followed by a non-breaking space, and leaves the rest of the note byte for byte', () => {
    const r = setTaskArea(note, 't4', 'growth');
    expect(r.ok && text(r.html, 't4')).toBe('🌱 Walk 09:00');
    expect(r.ok && r.html.replace('🌱 Walk 09:00', '🔋&nbsp;Walk 09:00')).toBe(note);
  });
  it('is unchanged when the marker is already right', () => {
    expect(setTaskArea(note, 't2', 'growth')).toEqual({ ok: true, html: note, unchanged: true });
  });
  it('fails for an unknown item, or one in Meetings', () => {
    expect(setTaskArea(note, 'zz', 'growth')).toEqual({ ok: false, reason: 'not_found' });
    expect(setTaskArea(note, 'p1', 'growth')).toMatchObject({ ok: false });
  });
});

describe('setTaskEstimate', () => {
  const note = '<h2>☑️ Tasks</h2>' + ul(
    li('t1', 'Write the spec'),
    li('t2', 'Draft &amp; send ~1h !'),
    li('t3', 'Call back <em>from <a href="#root/srcnote">Mon 26 Oct</a></em> !'),
    li('t4', 'Plan', { sub: ul(li('t4a', 'Part one')) }),
    li('t5', 'Old part', { sub: ul(li('t5a', 'Closed', { checked: true })) }),
    li('t6', 'Done', { checked: true }),
    li('t7', 'Keep 30 min&nbsp;~30m'),
  ) + '<h2>Meetings</h2>' + ul(li('p1', 'Standup'));
  const text = (html: string, id: string) =>
    parse(html).querySelectorAll('li').find((l) => l.getAttribute('data-list-item-id') === id)?.querySelector('span.todo-list__label__description')?.innerHTML;

  it('adds a token, and replaces one in place, ahead of a trailing marker', () => {
    const added = setTaskEstimate(note, 't1', 30);
    expect(added).toMatchObject({ ok: true, unchanged: false });
    expect(added.ok && text(added.html, 't1')).toBe('Write the spec ~30m');
    const replaced = setTaskEstimate(note, 't2', 90);
    expect(replaced.ok && text(replaced.html, 't2')).toBe('Draft &amp; send ~1h30m !');
    const marked = setTaskEstimate(note, 't3', 120);
    expect(marked.ok && text(marked.html, 't3')).toBe('Call back <em>from <a href="#root/srcnote">Mon 26 Oct</a></em> ~2h !');
    expect(replaced.ok && replaced.html.replace('~1h30m', '~1h')).toBe(note.replace('~1h !', '~1h !'));
  });
  it('writes minutes below an hour, whole hours and hours with minutes', () => {
    const at = (minutes: number) => { const r = setTaskEstimate(note, 't1', minutes); return r.ok && text(r.html, 't1'); };
    expect([at(15), at(60), at(600), at(75)]).toEqual(['Write the spec ~15m', 'Write the spec ~1h', 'Write the spec ~10h', 'Write the spec ~1h15m']);
  });
  it('reads a token after a non-breaking space, and is unchanged for an equal one in another form', () => {
    expect(setTaskEstimate(note, 't7', 30)).toEqual({ ok: true, html: note, unchanged: true });
    expect(setTaskEstimate(note, 't2', 60)).toEqual({ ok: true, html: note, unchanged: true });
    const r = setTaskEstimate(note, 't7', 45);
    expect(r.ok && text(r.html, 't7')).toBe('Keep 30 min&nbsp;~45m');
  });
  it('skips a parent with live sub-items, but not one whose sub-items are closed', () => {
    expect(setTaskEstimate(note, 't4', 30, STATES)).toEqual({ ok: false, reason: 'has_subitems' });
    expect(setTaskEstimate(note, 't5', 30, STATES)).toMatchObject({ ok: true, unchanged: false });
  });
  it('fails for an unknown, closed or Meetings item', () => {
    expect(setTaskEstimate(note, 'zz', 30)).toEqual({ ok: false, reason: 'not_found' });
    expect(setTaskEstimate(note, 't6', 30)).toEqual({ ok: false, reason: 'not_live' });
    expect(setTaskEstimate(note, 'p1', 30)).toMatchObject({ ok: false });
  });
});

describe('placeInDay', () => {
  const sub = ul(li('m2a', 'B1'));
  const note = '<h2>☑️ Tasks</h2><h3>Morning</h3>' + ul(li('m1', 'A'), li('m2', 'B ~30m', { state: 'doing', sub }), li('m3', 'Done', { checked: true }))
    + '<h3>Afternoon</h3>' + ul(li('a1', 'C')) + '<h3>On deck</h3>' + ul(li('d1', 'D'), li('d2', 'E')) + '<h3>Suggested</h3>' + ul(li('s1', 'S'));
  const place = (html: string, id: string, at: Parameters<typeof placeInDay>[2]) => {
    const r = placeInDay(html, id, at, STATES);
    if (!r.ok) throw new Error(`${id}: ${r.reason}`);
    return r;
  };

  it('moves a task from Morning to Afternoon, the same item with its state, sub-items and id', () => {
    const r = place(note, 'm2', { block: 'afternoon' });
    expect(r.unchanged).toBe(false);
    expect(ids(r.html)).toEqual(['m1', 'm3', 'a1', 'm2', 'm2a', 'd1', 'd2', 's1']);
    expect(r.html).toContain(`<h3>Afternoon</h3>${ul(li('a1', 'C'), li('m2', 'B ~30m', { state: 'doing', sub }))}<h3>On deck</h3>`);
  });
  it('puts a task On deck and back onto the list, which is the end of the first block with a list', () => {
    const deck = place(note, 'm1', { onDeck: true });
    expect(ids(deck.html)).toEqual(['m2', 'm2a', 'm3', 'a1', 'd1', 'd2', 'm1', 's1']);
    const back = place(deck.html, 'm1', { onDeck: false });
    expect(ids(back.html)).toEqual(['m2', 'm2a', 'm3', 'm1', 'a1', 'd1', 'd2', 's1']);
  });
  it('takes the On deck heading away with its last item, and leaves an emptied block heading', () => {
    const one = '<h2>☑️ Tasks</h2><h3>Morning</h3>' + ul(li('m1', 'A')) + '<h3>On deck</h3>' + ul(li('d1', 'D')) + '<h3>Suggested</h3>' + ul(li('s1', 'S'));
    const committed = place(one, 'd1', { block: 'morning' });
    expect(committed.html).toBe('<h2>☑️ Tasks</h2><h3>Morning</h3>' + ul(li('m1', 'A'), li('d1', 'D')) + '<h3>Suggested</h3>' + ul(li('s1', 'S')));
    const decked = place(one, 'm1', { onDeck: true });
    expect(decked.html).toBe('<h2>☑️ Tasks</h2><h3>Morning</h3><h3>On deck</h3>' + ul(li('d1', 'D'), li('m1', 'A')) + '<h3>Suggested</h3>' + ul(li('s1', 'S')));
  });
  it('places before or after another item, in its list or in the target named', () => {
    expect(ids(place(note, 'a1', { before: 'm1' }).html)).toEqual(['a1', 'm1', 'm2', 'm2a', 'm3', 'd1', 'd2', 's1']);
    expect(ids(place(note, 'm1', { after: 'm2' }).html)).toEqual(['m2', 'm2a', 'm1', 'm3', 'a1', 'd1', 'd2', 's1']);
    expect(ids(place(note, 'm1', { onDeck: true, before: 'd2' }).html)).toEqual(['m2', 'm2a', 'm3', 'a1', 'd1', 'm1', 'd2', 's1']);
    expect(ids(place(note, 'd2', { block: 'morning', after: 'm1' }).html)).toEqual(['m1', 'd2', 'm2', 'm2a', 'm3', 'a1', 'd1', 's1']);
  });
  it('makes the Evening heading when the day has none', () => {
    const r = place(note, 'a1', { block: 'evening' });
    expect(r.html).toContain(`<h3>Afternoon</h3><h3>Evening</h3>${ul(li('a1', 'C'))}<h3>On deck</h3>`);
  });
  it('is unchanged where the task already is, however its heading is dressed', () => {
    const dressed = note.replace('<h3>On deck</h3>', '<h4>🃏 On deck</h4>');
    for (const [id, at] of [
      ['m1', { block: 'morning' }], ['m1', { onDeck: false }], ['m2', { after: 'm1' }], ['m1', { before: 'm2' }], ['d1', { onDeck: true }], ['d2', { onDeck: true, after: 'd1' }],
    ] as const) {
      expect(placeInDay(dressed, id, at, STATES)).toEqual({ ok: true, html: dressed, unchanged: true });
    }
  });
  it('refuses what it cannot place, and an anchor outside the target', () => {
    const withMore = critical(li('c1', 'Rent')) + note + '<h2>Meetings</h2>' + ul(li('p1', 'Standup'));
    const reason = (id: string, at: Parameters<typeof placeInDay>[2]) => {
      const r = placeInDay(withMore, id, at, STATES);
      return r.ok ? 'ok' : r.reason;
    };
    expect([
      reason('zz', { block: 'morning' }),
      reason('m2a', { block: 'afternoon' }),
      reason('m3', { block: 'afternoon' }),
      reason('p1', { block: 'afternoon' }),
      reason('s1', { block: 'afternoon' }),
      reason('c1', { block: 'afternoon' }),
      reason('m1', { before: 'zz' }),
      reason('m1', { block: 'afternoon', before: 'd1' }),
      reason('m1', { onDeck: true, after: 'a1' }),
      reason('d1', { onDeck: false, before: 'd2' }),
      reason('m1', { before: 's1' }),
      reason('m1', { before: 'm2a' }),
      reason('m1', { block: 'morning', onDeck: true }),
      reason('m1', {}),
    ]).toEqual(['not_found', 'bad_request', 'not_live', 'not_live', 'bad_request', 'bad_request', 'not_found', 'bad_request', 'bad_request', 'bad_request', 'bad_request', 'bad_request', 'bad_request', 'bad_request']);
    const parent = placeInDay(withMore, 'm2a', { block: 'afternoon' }, STATES);
    expect(parent.ok ? '' : parent.detail).toBe('place its parent');
  });
});
