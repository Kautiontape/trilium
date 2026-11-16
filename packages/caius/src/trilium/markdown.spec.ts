import { describe, it, expect } from 'vitest';
import { parseDocument } from '../core/index.js';
import { DEFAULT_STATE_SYMBOLS, htmlToMarkdown, htmlToMarkdownWithIds } from './markdown.js';

const STATES = new Map([
  ['doing', '/'],
  ['maybe', '?'],
  ['cancelled', '-'],
  ['_rescheduled', '>'],
]);

const todo = (text: string, opts: { checked?: boolean; state?: string; sub?: string } = {}) =>
  `<li${opts.state ? ` data-trilium-task-state="${opts.state}"` : ''}><label class="todo-list__label">` +
  `<input type="checkbox"${opts.checked ? ' checked="checked"' : ''} disabled="disabled">` +
  `<span class="todo-list__label__description">${text}</span></label>${opts.sub ?? ''}</li>`;

const html =
  '<h2>☑️ Tasks</h2><ul class="todo-list">' +
  todo('Open task') +
  todo('Done task', { checked: true }) +
  todo('Doing task', { state: 'doing' }) +
  todo('Moved task', { state: '_rescheduled', checked: true }) +
  todo('Dropped task', { state: 'cancelled' }) +
  todo('Maybe task', { state: 'maybe' }) +
  todo('Parent task', { sub: `<ul class="todo-list">${todo('Child task', { checked: true })}</ul>` }) +
  '</ul><h3>Notes</h3><ul><li>[>] Typed marker in a plain list</li><li>Just a bullet</li></ul>' +
  '<p>See <a href="https://example.com/T-1">T-1</a> ~2h</p>';

describe('htmlToMarkdown', () => {
  const md = htmlToMarkdown(html, STATES);

  it('emits the state symbol, preferring the state attribute over the checkbox', () => {
    expect(md).toContain('- [ ] Open task');
    expect(md).toContain('- [x] Done task');
    expect(md).toContain('- [/] Doing task');
    expect(md).toContain('- [>] Moved task');
    expect(md).toContain('- [-] Dropped task');
    expect(md).toContain('- [?] Maybe task');
  });

  it('nests a sub-list directly under its parent, judged by its own checkbox', () => {
    expect(md).toContain('- [ ] Parent task\n    - [x] Child task');
  });

  it('keeps text unescaped and headings as atx', () => {
    expect(md).toContain('- [>] Typed marker in a plain list');
    expect(md).toContain('## ☑️ Tasks');
    expect(md).toContain('[T-1](https://example.com/T-1) ~2h');
  });

  it('parses into Caius tasks with the right states and nesting', () => {
    const tasks = parseDocument(md, { tabWidth: 4 });
    const state = (text: string) => tasks.find((t) => t.text === text)?.state;
    expect(state('Open task')).toBe('open');
    expect(state('Done task')).toBe('done');
    expect(state('Doing task')).toBe('in_progress');
    expect(state('Moved task')).toBe('tombstone');
    expect(state('Dropped task')).toBe('cancelled');
    expect(state('Typed marker in a plain list')).toBe('tombstone');
    expect(state('Maybe task')).toBeUndefined(); // `?` is not a Caius state (D1)
    const child = tasks.find((t) => t.text === 'Child task')!;
    const parent = tasks.find((t) => t.text === 'Parent task')!;
    expect(child.parentLine).toBe(parent.line);
  });
});

describe('htmlToMarkdownWithIds', () => {
  const withId = (id: string, text: string, sub = '') =>
    `<li data-list-item-id="${id}"><label class="todo-list__label"><input type="checkbox" disabled="disabled"><span class="todo-list__label__description">${text}</span></label>${sub}</li>`;
  const doc = `<h2>Tasks</h2><ul class="todo-list">${withId('eaaa', 'First')}${withId('ebbb', 'Parent', `<ul class="todo-list">${withId('eccc', 'Child')}</ul>`)}</ul><ul><li>Plain</li></ul>`;

  it('maps each task line to its li id without changing the markdown', () => {
    const { markdown, itemIds } = htmlToMarkdownWithIds(doc, STATES);
    expect(markdown).toBe(htmlToMarkdown(doc, STATES));
    expect(markdown).not.toMatch(/[]/);
    const lines = markdown.split('\n');
    expect([...itemIds].map(([i, id]) => [lines[i], id])).toEqual([
      ['- [ ] First', 'eaaa'],
      ['- [ ] Parent', 'ebbb'],
      ['    - [ ] Child', 'eccc'],
    ]);
  });

  it('lines up with the parser\'s 0-based task lines', () => {
    const { markdown, itemIds } = htmlToMarkdownWithIds(doc, STATES);
    const ids = parseDocument(markdown).map((t) => itemIds.get(t.line));
    expect(ids).toEqual(['eaaa', 'ebbb', 'eccc']);
  });
});

describe('htmlToMarkdown on a moved task\'s "scheduled" mark', () => {
  const MARKS: Record<string, [string, string]> = {
    'as written': ['<em>scheduled <a href="#root/tue">Tue 3 Nov</a></em>', 'Tue 3 Nov'],
    'as the editor saves it': ['<em>scheduled </em><a href="#root/tue"><em>Tue 3 Nov</em></a>', 'Tue 3 Nov'],
    'as a saved reference link': ['<em>scheduled&nbsp;</em><a class="reference-link" href="#root/tue">03 - Tuesday</a>', '03 - Tuesday'],
    'after the Markdown round trip': ['<em>scheduled</em> <a href="#root/tue"><em>Tue 3 Nov</em></a>', 'Tue 3 Nov'],
    'as a reference link after the round trip': ['<em>scheduled</em>&nbsp;<a class="reference-link" href="#root/tue">03 - Tuesday</a>', '03 - Tuesday'],
  };
  const moved = (text: string) => htmlToMarkdownWithIds(`<ul class="todo-list">${todo(text, { state: '_rescheduled', checked: true }).replace('<li ', '<li data-list-item-id="t1" ')}</ul>`, STATES);

  it.each(Object.entries(MARKS))('reads the mark %s as written, with the item id kept', (_shape, [mark, label]) => {
    const out = moved(`Ring the plumber ${mark}`);
    expect(out.markdown).toBe(`- [>] Ring the plumber _scheduled [${label}](#root/tue)_`);
    expect(out.markdown).not.toContain('\u00a0');
    expect(out.itemIds.get(0)).toBe('t1');
  });

  it('leaves a bare "scheduled", his own word and other #root/ links as they are', () => {
    expect(moved('Ring the plumber <em>scheduled</em>').markdown).toBe('- [>] Ring the plumber _scheduled_');
    expect(moved('Ring the plumber scheduled <a href="#root/tue">Tue 3 Nov</a>').markdown).toBe('- [>] Ring the plumber scheduled [Tue 3 Nov](#root/tue)');
    expect(moved('Ring the plumber <em>scheduled <a href="#root/tue">Tue 3 Nov</a></em> and <a href="#root/x">a b</a>').markdown)
      .toBe('- [>] Ring the plumber _scheduled [Tue 3 Nov](#root/tue)_ and [a b](#root/x)');
  });
});

describe('htmlToMarkdown on a _rescheduled item the states do not list', () => {
  const moved = `<ul class="todo-list">${todo('Moved task', { state: '_rescheduled', checked: true })}</ul>`;

  it('reads it as Rescheduled, and lets a listed symbol win', () => {
    expect(htmlToMarkdown(moved, DEFAULT_STATE_SYMBOLS)).toBe('- [>] Moved task');
    expect(htmlToMarkdown(moved, new Map([['_rescheduled', '~']]))).toBe('- [~] Moved task');
  });
});

describe('htmlToMarkdownWithIds on a saved mark in harder notes', () => {
  const saved = (label: string) => `<em>scheduled </em><a href="#root/tue"><em>${label}</em></a>`;
  const written = (label: string) => `_scheduled [${label}](#root/tue)_`;
  const item = (id: string, text: string, sub = '') =>
    todo(text, { state: '_rescheduled', checked: true, sub }).replace('<li ', `<li data-list-item-id="${id}" `);

  it('reads a mark on a nested sub-item', () => {
    const out = htmlToMarkdownWithIds(
      `<ul class="todo-list">${item('p1', 'Parent', `<ul class="todo-list">${item('c1', `Child ${saved('Tue 3 Nov')}`)}</ul>`)}</ul>`,
      STATES,
    );
    expect(out.markdown).toBe(`- [>] Parent\n    - [>] Child ${written('Tue 3 Nov')}`);
    expect([...out.itemIds]).toEqual([[0, 'p1'], [1, 'c1']]);
    expect([...out.critical]).toEqual([]);
  });

  it('reads a mark on an item inside an Important aside', () => {
    const out = htmlToMarkdownWithIds(
      `<aside class="admonition important"><ul class="todo-list">${item('a1', `Urgent ${saved('Tue 3 Nov')}`)}</ul></aside>`,
      STATES,
    );
    expect(out.markdown).toBe(`- [>] Urgent ${written('Tue 3 Nov')} !!!`);
    expect([...out.itemIds]).toEqual([[0, 'a1']]);
    expect([...out.critical]).toEqual([0]);
  });

  it('reads two marks on one line', () => {
    const out = htmlToMarkdownWithIds(
      `<ul class="todo-list">${item('t1', `Ring ${saved('Tue 3 Nov')} ${saved('Wed 4 Nov')}`)}</ul>`,
      STATES,
    );
    expect(out.markdown).toBe(`- [>] Ring ${written('Tue 3 Nov')} ${written('Wed 4 Nov')}`);
    expect([...out.itemIds]).toEqual([[0, 't1']]);
    expect([...out.critical]).toEqual([]);
  });

  it('reads marks on two items', () => {
    const out = htmlToMarkdownWithIds(
      `<ul class="todo-list">${item('t1', `One ${saved('Tue 3 Nov')}`)}${item('t2', `Two ${saved('Wed 4 Nov')}`)}</ul>`,
      STATES,
    );
    expect(out.markdown).toBe(`- [>] One ${written('Tue 3 Nov')}\n- [>] Two ${written('Wed 4 Nov')}`);
    expect([...out.itemIds]).toEqual([[0, 't1'], [1, 't2']]);
    expect([...out.critical]).toEqual([]);
  });
});

describe('htmlToMarkdown on a mark after the trailing tokens', () => {
  const MARKS = {
    written: '<em>scheduled <a href="#root/tue">Tue 3 Nov</a></em>',
    saved: '<em>scheduled </em><a href="#root/tue"><em>Tue 3 Nov</em></a>',
  };
  const line = (text: string, state?: string) =>
    htmlToMarkdown(`<ul class="todo-list">${todo(text, { state, checked: state === '_rescheduled' })}</ul>`, STATES);

  it.each(Object.entries(MARKS))('places the %s mark ahead of the tokens, open or moved', (_shape, mark) => {
    expect(line(`Write it ~30m ${mark}`)).toBe('- [ ] Write it _scheduled [Tue 3 Nov](#root/tue)_ ~30m');
    expect(line(`Write it ~30m ${mark}`, '_rescheduled')).toBe('- [>] Write it _scheduled [Tue 3 Nov](#root/tue)_ ~30m');
    expect(line(`Write it ~30m ! ${mark}`)).toBe('- [ ] Write it _scheduled [Tue 3 Nov](#root/tue)_ ~30m !');
  });

  it('leaves a mark already before the tokens, and a line without tokens, where they are', () => {
    expect(line(`Write it ${MARKS.saved} ~30m`)).toBe('- [ ] Write it _scheduled [Tue 3 Nov](#root/tue)_ ~30m');
    expect(line(`Write it ${MARKS.saved}`)).toBe('- [ ] Write it _scheduled [Tue 3 Nov](#root/tue)_');
  });
});

describe('htmlToMarkdown on a mark next to a no-break space, and on odd markup', () => {
  const mark = '<em>scheduled <a href="#root/tue">Tue 3 Nov</a></em>';
  const line = (text: string) => htmlToMarkdown(`<ul class="todo-list">${todo(text)}</ul>`, STATES).replace(/\s+/g, ' ');
  const body = '_scheduled [Tue 3 Nov](#root/tue)_';

  it('reads the tokens when the text has a no-break space before them or after the mark', () => {
    expect(line(`Write it&nbsp;~30m ${mark}`)).toBe(`- [ ] Write it ${body} ~30m`);
    expect(line(`Write it &nbsp;~30m ${mark}`)).toBe(`- [ ] Write it ${body} ~30m`);
    expect(line(`Write it ~30m ${mark}&nbsp;`)).toBe(`- [ ] Write it ${body} ~30m`);
  });

  it('converts a description closed with `</span >` without throwing', () => {
    const odd = `<ul class="todo-list"><li><label class="todo-list__label"><input type="checkbox" disabled="disabled"><span class="todo-list__label__description">Write it ~30m ${mark}</span ></label></li></ul>`;
    expect(() => htmlToMarkdown(odd, STATES)).not.toThrow();
    expect(htmlToMarkdown(odd, STATES)).toContain('Write it');
  });
});
