import { afterEach, describe, expect, it } from 'vitest';
import { now } from './clock.js';
import { scanDocs } from './index/index.js';
import { TRILIUM_CONFIG } from './trilium/config.js';

const SAVED = { env: process.env.TRILIUM_ENV, now: process.env.CAIUS_NOW };

afterEach(() => {
  for (const [name, value] of [['TRILIUM_ENV', SAVED.env], ['CAIUS_NOW', SAVED.now]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('now', () => {
  it('returns CAIUS_NOW as local time only under TRILIUM_ENV=dev', () => {
    const dev = { TRILIUM_ENV: 'dev', CAIUS_NOW: '2026-11-06T17:30' };
    const at = now(dev);
    expect([at.getFullYear(), at.getMonth(), at.getDate(), at.getHours(), at.getMinutes()]).toEqual([2026, 10, 6, 17, 30]);

    const before = Date.now();
    for (const env of [{ CAIUS_NOW: dev.CAIUS_NOW }, { ...dev, TRILIUM_ENV: 'production' }, { TRILIUM_ENV: 'dev' }, { ...dev, CAIUS_NOW: 'tomorrow' }]) {
      expect(now(env).getTime()).toBeGreaterThanOrEqual(before);
    }
  });

  it('takes the real time from the fallback when there is no override', () => {
    const real = new Date(2026, 0, 2, 3, 4);
    expect(now({}, () => real)).toBe(real);
    expect(now({ TRILIUM_ENV: 'dev', CAIUS_NOW: '2026-11-06T17:30' }, () => real)).not.toBe(real);
  });

  it('reads process.env by default', () => {
    process.env.TRILIUM_ENV = 'dev';
    process.env.CAIUS_NOW = '2026-11-06T17:30';
    expect(now().getDate()).toBe(6);
    process.env.TRILIUM_ENV = 'production';
    const before = Date.now();
    expect(now().getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe('lanes follow the clock', () => {
  it('puts the same task in a different lane as CAIUS_NOW moves', () => {
    const docs = [{ path: 'Journal/Daily/2026-11-06.md', text: '- [ ] Write the thing\n', mtime: 0 }];
    const lane = () => scanDocs(docs, TRILIUM_CONFIG).tasks[0]?.horizon;
    process.env.TRILIUM_ENV = 'dev';
    process.env.CAIUS_NOW = '2026-11-06T17:30';
    expect(lane()).toBe('today');
    process.env.CAIUS_NOW = '2026-11-05T09:00';
    expect(lane()).toBe('week');
    process.env.CAIUS_NOW = '2026-11-09T09:00';
    expect(lane()).toBe('overdue');
    process.env.TRILIUM_ENV = 'production';
    expect(lane()).toBe(scanDocs(docs, TRILIUM_CONFIG, new Date()).tasks[0]?.horizon);
  });
});
