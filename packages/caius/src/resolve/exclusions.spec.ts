import { describe, it, expect } from 'vitest';
import { isExcluded } from './exclusions.js';
import { DEFAULT_CONFIG } from './config.js';

const x = (file: string) => isExcluded(file, DEFAULT_CONFIG);

describe('isExcluded', () => {
  it('excludes the Inbox capture zone (D8)', () => {
    expect(x('01 - Inbox/quick note.md')).toBe(true);
  });
  it('excludes Resources / Archive / Maintenance', () => {
    expect(x('30 - Resources/paper.md')).toBe(true);
    expect(x('80 - Archive/old.md')).toBe(true);
    expect(x('90 - Maintenance/Vault Health.md')).toBe(true);
  });
  it('excludes dotfolders', () => {
    expect(x('.obsidian/workspace.json')).toBe(true);
    expect(x('.trash/deleted.md')).toBe(true);
  });
  it('does NOT exclude indexed areas', () => {
    expect(x('02 - Periodic/Daily/2026/06/2026-06-17.md')).toBe(false);
    expect(x('10 - Project/Caius/notes.md')).toBe(false);
    expect(x('20 - Area/Health.md')).toBe(false);
  });
  it('does not over-match a similarly-named folder', () => {
    expect(x('01 - Inboxer/notes.md')).toBe(false);
  });
});
