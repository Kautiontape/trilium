import { describe, it, expect } from 'vitest';
import { parse } from 'node-html-parser';
import { dayLabel, periodLabel, hasCopy, insertCopy, inspectItem, markRescheduled } from './forward-html.js';

const STATES = new Map([
  ['doing', '/'],
  ['cancelled', '-'],
  ['_rescheduled', '>'],
]);

const li = (id: string, text: string, o: { checked?: boolean; state?: string; sub?: string; extra?: string } = {}) =>
  `<li data-list-item-id="${id}"${o.state ? ` data-trilium-task-state="${o.state}"` : ''}${o.extra ?? ''}>` +
  `<label class="todo-list__label"><input type="checkbox"${o.checked ? ' checked="checked"' : ''} disabled="disabled">` +
  `<span class="todo-list__label__description">${text}</span></label>${o.sub ?? ''}</li>`;
const ul = (...items: string[]) => `<ul class="todo-list">${items.join('')}</ul>`;

const hex32 = /^e[0-9a-f]{32}$/;
const ids = (html: string) => parse(html).querySelectorAll('li').map((l) => l.getAttribute('data-list-item-id'));
const text = (html: string, id: string) =>
  parse(html).querySelectorAll('li').find((l) => l.getAttribute('data-list-item-id') === id)!.querySelector('span.todo-list__label__description')!.innerHTML;

const SRC_ID = 'srcnote';
const TGT_ID = 'tgtnote';
const mark = { targetNoteId: TGT_ID, targetLabel: 'Tuesday 27', states: STATES };
const copy = { sourceNoteId: SRC_ID, sourceLabel: 'Monday 26', states: STATES };

describe('periodLabel', () => {
  it('names a day, week or month in the short style, adding the year to a month in another year', () => {
    expect(periodLabel('2026-10-27')).toBe('Tuesday 27');
    expect(periodLabel('2026-W45')).toBe('week 45');
    expect(periodLabel('2026-W05')).toBe('week 5');
    expect(periodLabel('2026-11')).toBe('November');
    expect(periodLabel('2026-11', 2026)).toBe('November');
    expect(periodLabel('2027-01', 2026)).toBe('January 2027');
    expect(periodLabel('2027-W02', 2026)).toBe('week 2');
    expect(periodLabel('2027-01-04', 2026)).toBe('Monday 4');
    expect(periodLabel('nonsense')).toBe('nonsense');
  });
});

describe('dayLabel', () => {
  it('names the weekday and day of month', () => {
    expect(dayLabel('2026-10-27')).toBe('Tuesday 27');
    expect(dayLabel('2026-11-01')).toBe('Sunday 1');
  });
});

describe('markRescheduled', () => {
  const src =
    '<h2>☑️ Tasks</h2><p>keep &amp; <b>me</b>  </p>' +
    ul(li('eone', 'Do it &amp; more', { extra: ' title="x"' }), li('etwo', 'Other')) +
    '<h3>Work</h3>' +
    ul(li('ewrk', 'Work item'));

  it('sets the state, title and checked box, adds the italic scheduled link, and touches nothing else', () => {
    const r = markRescheduled(src, 'eone', mark);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const expected = src.replace(
      li('eone', 'Do it &amp; more', { extra: ' title="x"' }),
      '<li data-list-item-id="eone" data-trilium-task-state="_rescheduled" title="Rescheduled">' +
        '<label class="todo-list__label"><input type="checkbox" checked="checked" disabled="disabled">' +
        '<span class="todo-list__label__description">Do it &amp; more <em>scheduled <a class="reference-link" href="#root/tgtnote">Tuesday 27</a></em></span></label></li>',
    );
    expect(r.html).toBe(expected);
  });

  it('replaces an existing state and title rather than duplicating them', () => {
    const doing = ul(li('edo', 'In progress', { state: 'doing', extra: ' title="Doing"' }));
    const r = markRescheduled(doing, 'edo', mark);
    expect(r.ok && r.html.match(/data-trilium-task-state/g)).toHaveLength(1);
    expect(r.ok && r.html).toContain('data-trilium-task-state="_rescheduled" title="Rescheduled"');
  });

  it('also reschedules live sub-items but leaves closed ones alone', () => {
    const nested = ul(li('epar', 'Parent', { sub: ul(li('eopen', 'Open child'), li('edone', 'Done child', { checked: true })) }));
    const r = markRescheduled(nested, 'epar', mark);
    if (!r.ok) throw new Error('expected ok');
    const state = (id: string) => parse(r.html).querySelectorAll('li').find((l) => l.getAttribute('data-list-item-id') === id)!.getAttribute('data-trilium-task-state');
    expect(state('epar')).toBe('_rescheduled');
    expect(state('eopen')).toBe('_rescheduled');
    expect(state('edone')).toBeUndefined();
    expect(r.html.match(/<em>/g)).toHaveLength(1);
  });

  it('reports why it cannot', () => {
    const html = ul(li('edone', 'Done', { checked: true }), li('emoved', 'Moved', { state: '_rescheduled', checked: true }), li('ecan', 'No', { state: 'cancelled' })) + '<ul><li data-list-item-id="eplain">Bullet</li></ul>';
    expect(markRescheduled(html, 'enope', mark)).toMatchObject({ ok: false, reason: 'not_found' });
    expect(markRescheduled(html, 'edone', mark)).toMatchObject({ ok: false, reason: 'not_live' });
    expect(markRescheduled(html, 'ecan', mark)).toMatchObject({ ok: false, reason: 'not_live' });
    expect(markRescheduled(html, 'eplain', mark)).toMatchObject({ ok: false, reason: 'not_live' });
    expect(markRescheduled(html, 'emoved', mark)).toMatchObject({ ok: false, reason: 'already_moved' });
  });

  it('is a no-op the second time and says where it was scheduled', () => {
    const once = markRescheduled(ul(li('eone', 'Do it')), 'eone', mark);
    if (!once.ok) throw new Error('expected ok');
    const again = markRescheduled(once.html, 'eone', mark);
    expect(again).toEqual({ ok: false, reason: 'already_moved', scheduledTo: [TGT_ID] });
  });
});

describe('insertCopy and Doing', () => {
  it('keeps a Doing task Doing in the copy, with a fresh id', () => {
    const src = '<h3>Work</h3>' + ul(li('edo', 'Underway', { state: 'doing', extra: ' title="Doing"' }));
    const r = insertCopy('<h3>Work</h3>' + ul(li('eold', 'Old')), src, 'edo', copy);
    if (!r.ok) throw new Error('expected ok');
    expect(r.html).toMatch(/<li data-list-item-id="e[0-9a-f]{32}" data-trilium-task-state="doing" title="Doing"><label[^>]*><input type="checkbox" disabled="disabled">/);
    expect(r.html).not.toContain('"edo"');
  });
});

describe('insertCopy', () => {
  const source =
    '<h2>☑️ Tasks</h2><h3>Work</h3>' +
    ul(li('ewrk', 'Ship &amp; tell', { extra: ' title="t"', sub: ul(li('eopen', 'Open child'), li('edone', 'Done child', { checked: true }), li('edoing', 'Child doing', { state: 'doing' })) }));

  it('appends under the heading with the same name, with fresh ids and no state', () => {
    const target = '<h2>☑️ Tasks</h2><h3>Home</h3>' + ul(li('ehome', 'Home item')) + '<h3>Work</h3>' + ul(li('ewrk2', 'Existing')) + '<p>tail</p>';
    const r = insertCopy(target, source, 'ewrk', copy);
    if (!r.ok) throw new Error('expected ok');
    expect(r.section).toBe('Work');
    const copied = r.html.slice(r.html.indexOf(li('ewrk2', 'Existing')) + li('ewrk2', 'Existing').length);
    expect(copied.startsWith('<li data-list-item-id="e')).toBe(true);
    expect(copied).toContain('Ship &amp; tell <a class="reference-link" href="#root/srcnote">from Monday 26</a>');
    // only the sub-item that was Doing keeps its state; the parent's old title is gone
    expect(copied.match(/data-trilium-task-state/g)).toHaveLength(1);
    expect(copied).toMatch(/<li data-list-item-id="e[0-9a-f]{32}" data-trilium-task-state="doing">/);
    expect(copied).not.toContain('title="t"');
    expect(copied).not.toContain('checked');
    expect(copied).not.toContain('Done child');
    expect(copied).toContain('Open child');
    expect(copied).toContain('Child doing');
    expect(copied.endsWith('</ul><p>tail</p>')).toBe(true);
    const all = ids(r.html);
    expect(all).toHaveLength(new Set(all).size);
    for (const id of all.slice(2).filter((i) => i !== 'ewrk2')) expect(id).toMatch(hex32);
    expect(r.html.startsWith('<h2>☑️ Tasks</h2><h3>Home</h3>' + ul(li('ehome', 'Home item')) + '<h3>Work</h3><ul class="todo-list">' + li('ewrk2', 'Existing'))).toBe(true);
  });

  it('puts the copy into a new list right under a matching heading that has none', () => {
    const r = insertCopy('<h3>Work</h3><p>note</p><h3>Next</h3>' + ul(li('eelse', 'Elsewhere')), source, 'ewrk', copy);
    if (!r.ok) throw new Error('expected ok');
    expect(r.html.startsWith('<h3>Work</h3><ul class="todo-list"><li data-list-item-id="e')).toBe(true);
    expect(r.html).toContain('<p>note</p>');
    expect(ids(r.html).filter((i) => i === 'eelse')).toHaveLength(1);
  });

  it('falls back to the first task list when the section is missing', () => {
    const target = '<h2>☑️ Tasks</h2><h3>Home</h3>' + ul(li('ehome', 'Home item')) + ul(li('elater', 'Later'));
    const r = insertCopy(target, source, 'ewrk', copy);
    if (!r.ok) throw new Error('expected ok');
    expect(ids(r.html)[0]).toBe('ehome');
    expect(ids(r.html)[1]).toMatch(hex32);
    expect(r.html.indexOf('from Monday 26')).toBeLessThan(r.html.indexOf('Later'));
  });

  it('creates a Tasks heading and list when the target has no task list', () => {
    const r = insertCopy('<p>just notes</p>', source, 'ewrk', copy);
    if (!r.ok) throw new Error('expected ok');
    expect(r.html.startsWith('<p>just notes</p><h2>☑️ Tasks</h2><ul class="todo-list"><li data-list-item-id="e')).toBe(true);
    expect(insertCopy('', source, 'ewrk', copy)).toMatchObject({ ok: true });
  });

  it('uses the injected id generator for the copy and its sub-items', () => {
    let n = 0;
    const r = insertCopy('', source, 'ewrk', { ...copy, newId: () => `enew${++n}` });
    if (!r.ok) throw new Error('expected ok');
    expect(ids(r.html)).toEqual(['enew1', 'enew2', 'enew3']);
  });

  it('copies a task with no section into the first task list', () => {
    const bare = ul(li('ebare', 'Bare'));
    const r = insertCopy('<h3>Work</h3>' + ul(li('ex', 'X')), bare, 'ebare', copy);
    expect(r).toMatchObject({ ok: true, section: null });
  });

  it('refuses closed, moved and unknown items without producing HTML', () => {
    const html = ul(li('edone', 'Done', { checked: true }), li('emoved', 'Moved', { state: '_rescheduled', checked: true }));
    expect(insertCopy('', html, 'edone', copy)).toMatchObject({ ok: false, reason: 'not_live' });
    expect(insertCopy('', html, 'emoved', copy)).toMatchObject({ ok: false, reason: 'already_moved' });
    expect(insertCopy('', html, 'ezzz', copy)).toMatchObject({ ok: false, reason: 'not_found' });
  });
});

describe('hasCopy and inspectItem', () => {
  const source = ul(li('eone', 'Do it'));
  it('recognises an earlier copy by its text and back link to the source', () => {
    const r = insertCopy('', source, 'eone', copy);
    if (!r.ok) throw new Error('expected ok');
    expect(hasCopy(r.html, source, 'eone', SRC_ID)).toBe(true);
    expect(hasCopy(r.html, source, 'eone', 'othernote')).toBe(false);
    expect(hasCopy(ul(li('ex', 'Do it')), source, 'eone', SRC_ID)).toBe(false);
  });

  it('reads an item\'s text and section', () => {
    expect(inspectItem('<h3>Work</h3>' + source, 'eone', STATES)).toEqual({ ok: true, text: 'Do it', section: 'Work' });
  });
});

describe('insertCopy into an untouched template day', () => {
  const template = '<h2>☑️ Tasks</h2><ul><li data-list-item-id="etemplate">[…]</li></ul>';
  const source = '<h2>☑️ Tasks</h2>' + ul(li('eone', 'Move me')) ;

  it('replaces the placeholder instead of adding a list above it', () => {
    const r = insertCopy(template, source, 'eone', copy);
    if (!r.ok) throw new Error('expected ok');
    expect(r.html).not.toContain('[…]');
    expect(r.html).not.toContain('etemplate');
    expect(r.html.startsWith('<h2>☑️ Tasks</h2><ul class="todo-list"><li data-list-item-id="e')).toBe(true);
    expect(r.html.match(/<ul/g)).toHaveLength(1);
  });
  it('replaces it when the source section has another name too', () => {
    const r = insertCopy(template, '<h3>Work</h3>' + ul(li('ew', 'Other section')), 'ew', copy);
    if (!r.ok) throw new Error('expected ok');
    expect(r.html).not.toContain('[…]');
    expect(r.html.match(/<ul/g)).toHaveLength(1);
  });
  it('skips the critical block and Suggested when picking the first list, and keeps Suggested last for a new list', () => {
    const target = '<aside class="admonition important">' + ul(li('ecrit', 'Critical')) + '</aside><h2>Suggested</h2>' + ul(li('esug', 'Maybe'));
    const r = insertCopy(target, '<h3>Home</h3>' + ul(li('eh', 'Home item')), 'eh', copy);
    if (!r.ok) throw new Error('expected ok');
    expect(r.html).toContain('</aside><h2>☑️ Tasks</h2><ul class="todo-list"><li data-list-item-id="e');
    expect(r.html.indexOf('Home item')).toBeLessThan(r.html.indexOf('<h2>Suggested</h2>'));
    expect(r.html.endsWith(ul(li('esug', 'Maybe')))).toBe(true);
  });
});

describe('trailing tokens stay trailing', () => {
  it('puts the "from" link before ~est, importance and due tokens, and the parser still reads them', async () => {
    const { htmlToMarkdown } = await import('./markdown.js');
    const { parseDocument } = await import('../core/index.js');
    const source = '<h3>Work</h3>' + ul(li('etok', 'Write it &amp; send ~30m ! *2026-10-30'));
    const r = insertCopy('<h3>Work</h3>', source, 'etok', copy);
    if (!r.ok) throw new Error('expected ok');
    expect(r.html).toContain('Write it &amp; send <a class="reference-link" href="#root/srcnote">from Monday 26</a> ~30m ! *2026-10-30</span>');
    const [task] = parseDocument(htmlToMarkdown(r.html, STATES), { tabWidth: 4 });
    expect(task!.tokens.map((t) => t.kind).sort()).toEqual(['due', 'estimate', 'importance']);
    expect(task!.text).toContain('from Monday 26');
  });
  it('still recognises its own copy afterwards (no duplicate on re-run)', () => {
    const source = '<h3>Work</h3>' + ul(li('etok', 'Write it ~30m'));
    const r = insertCopy('<h3>Work</h3>', source, 'etok', copy);
    if (!r.ok) throw new Error('expected ok');
    expect(hasCopy(r.html, source, 'etok', SRC_ID)).toBe(true);
    expect(hasCopy('<h3>Work</h3>', source, 'etok', SRC_ID)).toBe(false);
  });
});
