import { describe, it, expect } from 'vitest';
import { withListItemIds, type NoteStore } from './store.js';

describe('withListItemIds', () => {
  it('fills missing list item ids before each write, keeps `expected`, and passes everything else through', async () => {
    const writes: [string, string, string | undefined][] = [];
    const inner = {
      async content(noteId: string) {
        return `<p>${noteId}</p>`;
      },
      async putContent(noteId: string, html: string, expected?: string) {
        writes.push([noteId, html, expected]);
        return expected !== 'stale';
      },
    } as unknown as NoteStore;
    const store = withListItemIds(inner, () => 'enew');

    expect(await store.putContent('n1', '<ul><li>a</li></ul>', '<p>before</p>')).toBe(true);
    expect(await store.putContent('n2', '<ul><li data-list-item-id="ekeep">b</li></ul>')).toBe(true);
    expect(await store.putContent('n3', '<p>no list</p>', 'stale')).toBe(false);
    expect(await store.content('n4')).toBe('<p>n4</p>');

    expect(writes).toEqual([
      ['n1', '<ul><li data-list-item-id="enew">a</li></ul>', '<p>before</p>'],
      ['n2', '<ul><li data-list-item-id="ekeep">b</li></ul>', undefined],
      ['n3', '<p>no list</p>', 'stale'],
    ]);
  });
});
