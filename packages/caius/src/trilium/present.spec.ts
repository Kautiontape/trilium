import { describe, expect, it } from 'vitest';
import { diffSummary, presentResult } from './present.js';

describe('diffSummary', () => {
  it('keeps only what lies between the common head and tail', () => {
    expect(diffSummary('<ul><li>a</li><li>b</li></ul>', '<ul><li>a</li><li>x</li><li>b</li></ul>')).toEqual({
      removed: '',
      added: '<li>x</li>',
    });
    expect(diffSummary('<p>same</p>', '<p>same</p>')).toEqual({ removed: '', added: '' });
  });
});

describe('presentResult', () => {
  const result = {
    status: 'moved',
    changes: [
      { noteId: 'n1', role: 'target', before: '<p>a</p>', after: '<p>a</p><p>b</p>' },
      { noteId: 'n2', role: 'source', before: '<p>a</p>', after: '<p>a</p>', unchanged: true },
      { noteId: 'n3', role: 'source' },
    ],
  };

  it('summarises each change by default and returns the full HTML with html', () => {
    const shown = presentResult(result);
    expect(shown.changes).toEqual([
      { noteId: 'n1', role: 'target', removed: '', added: '<p>b</p>' },
      { noteId: 'n2', role: 'source', unchanged: true },
      { noteId: 'n3', role: 'source' },
    ]);
    expect(presentResult(result, true)).toBe(result);
    const plain = { status: 'skipped' };
    expect(presentResult(plain)).toBe(plain);
  });
});
