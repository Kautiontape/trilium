import { describe, expect, test } from 'vitest';
import { matchGlob, capture } from './glob.js';

describe('matchGlob — vault-relative POSIX globs (§7)', () => {
  test('* matches within a single segment, not across /', () => {
    expect(matchGlob('10 - Project/*.md', '10 - Project/Cactaur.md')).toBe(true);
    expect(matchGlob('10 - Project/*.md', '10 - Project/Cactaur/Cactaur.md')).toBe(false);
  });

  test('** matches any depth, including zero segments', () => {
    expect(matchGlob('02 - Periodic/Daily/**/*.md', '02 - Periodic/Daily/2026/06/2026-06-16.md')).toBe(true);
    expect(matchGlob('10 - Project/*/**/*.md', '10 - Project/Cactaur/Cactaur.md')).toBe(true); // ** = 0 segs
    expect(matchGlob('10 - Project/*/**/*.md', '10 - Project/DBQ/sub/note.md')).toBe(true);
  });

  test('*/*.md needs exactly one intermediate segment', () => {
    expect(matchGlob('10 - Project/*/*.md', '10 - Project/Cactaur/Cactaur.md')).toBe(true);
    expect(matchGlob('10 - Project/*/*.md', '10 - Project/Cactaur/scripts/x.md')).toBe(false);
  });

  test('is case-sensitive and anchored end-to-end', () => {
    expect(matchGlob('80 - Archive/**', '80 - archive/x.md')).toBe(false);
    expect(matchGlob('80 - Archive/**', 'before/80 - Archive/x.md')).toBe(false);
    expect(matchGlob('80 - Archive/**', '80 - Archive/deep/x.md')).toBe(true);
  });

  test('regex metacharacters in the pattern are treated literally', () => {
    expect(matchGlob('20 - Area/A.I. Research/*.md', '20 - Area/A.I. Research/note.md')).toBe(true);
    expect(matchGlob('20 - Area/A.I. Research/*.md', '20 - Area/AXIXResearch/note.md')).toBe(false);
  });
});

describe('capture — {seg1}/{filename}/{folder} (§7)', () => {
  test('{seg1} = first path segment after the literal prefix', () => {
    expect(capture('{seg1}', '10 - Project/*/**/*.md', '10 - Project/Cactaur/notes/x.md')).toBe('Cactaur');
  });

  test('{filename} = leaf without .md', () => {
    expect(capture('{filename}', '10 - Project/*.md', '10 - Project/Cactaur.md')).toBe('Cactaur');
  });

  test('{folder} = immediate parent directory name', () => {
    expect(capture('{folder}', '10 - Project/*/*.md', '10 - Project/Cactaur/Cactaur.md')).toBe('Cactaur');
  });
});
