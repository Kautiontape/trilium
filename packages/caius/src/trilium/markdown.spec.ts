import { describe, it, expect } from 'vitest';
import { parseDocument } from '../core/index.js';
import { htmlToMarkdown, htmlToMarkdownWithIds } from './markdown.js';

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
