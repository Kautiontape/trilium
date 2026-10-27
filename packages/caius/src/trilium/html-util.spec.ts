import { describe, it, expect } from 'vitest';
import { ensureListItemIds, listItemsWithoutIds } from './html-util.js';

const counter = () => {
  let n = 0;
  return () => `e${String(++n).padStart(32, '0')}`;
};
const id = (n: number) => `e${String(n).padStart(32, '0')}`;

const todo = (attrs: string, text: string, sub = '') =>
  `<li${attrs}><label class="todo-list__label"><input type="checkbox" disabled="disabled">` +
  `<span class="todo-list__label__description">${text}</span></label>${sub}</li>`;

describe('ensureListItemIds', () => {
  it('gives every list item without an id a new one, first on the tag, and keeps every other byte', () => {
    const html =
      '<h2>Tasks</h2>\n<ul class="todo-list">' +
      todo('', 'Plain') +
      todo(' data-trilium-task-state="doing" title="Doing"', 'Doing first') +
      todo(' title="Doing" data-list-item-id="ekeep"', 'Has an id') +
      todo(' data-list-item-id=""', 'Empty id') +
      '</ul>\n<ol><li class="x">One</li><li>Two</li></ol><p>after &amp; done</p>';

    expect(ensureListItemIds(html, counter())).toBe(
      '<h2>Tasks</h2>\n<ul class="todo-list">' +
        todo(` data-list-item-id="${id(1)}"`, 'Plain') +
        todo(` data-list-item-id="${id(2)}" data-trilium-task-state="doing" title="Doing"`, 'Doing first') +
        todo(' title="Doing" data-list-item-id="ekeep"', 'Has an id') +
        todo(` data-list-item-id="${id(3)}"`, 'Empty id') +
        `</ul>\n<ol><li data-list-item-id="${id(4)}" class="x">One</li><li data-list-item-id="${id(5)}">Two</li></ol><p>after &amp; done</p>`,
    );
  });

  it('reaches nested lists, of either kind, inside a task', () => {
    const html = `<ul class="todo-list">${todo('', 'Parent', `<ul><li>Bullet<ol><li>Deep</li></ol></li></ul>${'<ul class="todo-list">'}${todo(' data-list-item-id="eold"', 'Kept')}</ul>`)}</ul>`;
    const out = ensureListItemIds(html, counter());

    expect(out).toBe(
      `<ul class="todo-list">${todo(` data-list-item-id="${id(1)}"`, 'Parent', `<ul><li data-list-item-id="${id(2)}">Bullet<ol><li data-list-item-id="${id(3)}">Deep</li></ol></li></ul><ul class="todo-list">${todo(' data-list-item-id="eold"', 'Kept')}</ul>`)}</ul>`,
    );
    expect(listItemsWithoutIds(html)).toEqual(['Parent', 'Bullet', 'Deep']);
  });

  it('is idempotent, uses the CKEditor id shape by default, and leaves HTML with no list item to fill alone', () => {
    const once = ensureListItemIds('<ul><li>a</li><li>b</li></ul>');
    expect(once).toMatch(/^<ul><li data-list-item-id="e[0-9a-f]{32}">a<\/li><li data-list-item-id="e[0-9a-f]{32}">b<\/li><\/ul>$/);
    expect(ensureListItemIds(once)).toBe(once);
    expect(listItemsWithoutIds(once)).toEqual([]);

    for (const html of [
      '',
      '<p>No lists here, &nbsp; just  text</p>\n',
      '<!-- <ul><li>commented out</li></ul> --><p>x</p>',
      '<pre><code>&lt;ul&gt;&lt;li&gt;code&lt;/li&gt;&lt;/ul&gt;</code></pre>',
    ]) {
      expect(ensureListItemIds(html)).toBe(html);
    }
  });
});
