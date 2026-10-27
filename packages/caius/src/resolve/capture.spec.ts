import { describe, it, expect } from 'vitest';
import { defaultCaptureNote, DEFAULT_CONFIG } from './index.js';

describe('defaultCaptureNote', () => {
  it('returns today’s Daily periodic note (zero-padded)', () => {
    expect(defaultCaptureNote(new Date(2026, 5, 23))).toBe('02 - Periodic/Daily/2026/06/2026-06-23.md');
  });

  it('zero-pads single-digit month and day', () => {
    expect(defaultCaptureNote(new Date(2026, 0, 5))).toBe('02 - Periodic/Daily/2026/01/2026-01-05.md');
  });
});

describe('DEFAULT_CONFIG.captureNote', () => {
  it('defaults to null (use today’s daily note dynamically)', () => {
    expect(DEFAULT_CONFIG.captureNote).toBeNull();
  });
});
