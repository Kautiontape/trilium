import { describe, it, expect } from 'vitest';
import { parse } from 'node-html-parser';
import { placeTask, setTaskState, takeSuggested, itemMarkup } from './plan-html.js';
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
