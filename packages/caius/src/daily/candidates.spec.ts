import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeTrilium, li, periodNote, ul } from '../trilium/helpers.js';
import { loadJournal } from '../trilium/journal.js';
import { setKeyConfig } from '../trilium/keys.js';
import { dayCandidates, keysOf, liveKeys, type JiraLike } from './candidates.js';

beforeEach(() => setKeyConfig({ projects: ['QRS'], browseBase: 'https://example.atlassian.net/browse/' }));
afterEach(() => setKeyConfig({ projects: [], browseBase: null }));

const ticket = (key: string, o: { updated?: string; overridden?: true } = {}) => ({
  key, summary: `Summary of ${key}`, status: 'Dev Verify', url: `https://example.atlassian.net/browse/${key}`, updated: o.updated ?? '2026-11-05T10:00:00.000-0500', ...(o.overridden ? { overridden: o.overridden } : {}),
});

const jira: JiraLike = {
  handoff: [
    { ...ticket('QRS-1'), daysInStatus: 3 },
    { ...ticket('QRS-2'), daysInStatus: 1 },
    { ...ticket('QRS-3', { overridden: true }), daysInStatus: null },
  ],
  asks: [
    { ticket: ticket('QRS-4'), author: 'Sam Example', created: '2026-11-03T09:00:00.000-0500' },
    { ticket: ticket('QRS-4'), author: 'Riley Sample', created: '2026-11-04T09:00:00.000-0500' },
    { ticket: ticket('QRS-1'), author: 'Sam Example', created: '2026-11-04T09:00:00.000-0500' },
    { ticket: ticket('QRS-5'), author: 'Sam Example', created: '2026-11-04T09:00:00.000-0500' },
  ],
  done: ['QRS-5'],
};

const weekTask = (listItemId: string, text: string, estMinutes: number | null = null) => ({ noteId: 'w', listItemId, text, estMinutes });

describe('dayCandidates', () => {
  it('offers hand-offs, the latest ask per ticket and week items, leaving out done tickets and repeats', () => {
    const candidates = dayCandidates({
      jira,
      week: { key: '2026-W45', tasks: [weekTask('w1', 'Write the spec', 60), weekTask('w2', 'Plan the release')] },
      live: new Map([['QRS-2', ['d/e1']], [onlyKey('Write the spec'), ['w/w1']]]),
      exclude: [],
    });
    expect(candidates.map((c) => [c.subject, c.reason, c.minutes, c.source])).toEqual([
      ['QRS-1 Summary of QRS-1', { kind: 'handoff', status: 'Dev Verify', days: 3 }, 30, 'QRS-1'],
      ['QRS-3 Summary of QRS-3', { kind: 'handoff', status: 'Dev Verify', days: null }, 30, 'QRS-3'],
      ['QRS-4 Summary of QRS-4', { kind: 'ask', author: 'Riley Sample', created: '2026-11-04T09:00:00.000-0500' }, 30, 'QRS-4'],
      ['Write the spec', { kind: 'week', week: '2026-W45' }, 60, '2026-W45'],
      ['Plan the release', { kind: 'week', week: '2026-W45' }, 30, '2026-W45'],
    ]);
    expect(candidates[1]).toMatchObject({ overridden: true, url: 'https://example.atlassian.net/browse/QRS-3' });
    expect(candidates[3]).toMatchObject({ noteId: 'w', listItemId: 'w1' });
  });

  it('leaves out what is live elsewhere, already suggested or dismissed', () => {
    const candidates = dayCandidates({
      jira,
      week: { key: '2026-W45', tasks: [weekTask('w1', 'Write the spec')] },
      live: new Map([['QRS-1', ['d/e1']], [onlyKey('Write the spec'), ['w/w1', 'd/e9']]]),
      exclude: ['QRS-2', 'QRS-3', 'QRS-4'],
    });
    expect(candidates).toEqual([]);
  });

  it('leaves out a week item that names a ticket Jira calls done', () => {
    const candidates = dayCandidates({
      jira, week: { key: '2026-W45', tasks: [weekTask('w1', 'Close out QRS-5'), weekTask('w2', 'Write the spec')] }, live: new Map(), exclude: ['QRS-1', 'QRS-2', 'QRS-3', 'QRS-4'],
    });
    expect(candidates.map((c) => c.subject)).toEqual(['Write the spec']);
  });

  it('keeps only what is new since a time: asks after it, hand-offs updated after it, no week items', () => {
    const candidates = dayCandidates({
      jira: { ...jira, handoff: [{ ...ticket('QRS-7', { updated: '2026-11-06T09:30:00.000-0500' }), daysInStatus: 0 }, { ...ticket('QRS-8', { updated: '2026-11-02T10:00:00.000-0500' }), daysInStatus: 4 }] },
      week: { key: '2026-W45', tasks: [weekTask('w1', 'Write the spec')] },
      live: new Map(),
      exclude: [],
      since: new Date('2026-11-04T08:00:00-05:00'),
    });
    expect(candidates.map((c) => c.source)).toEqual(['QRS-7', 'QRS-4', 'QRS-1']);
  });
});

describe('liveKeys', () => {
  it('maps the key of every live task to where it is, leaving out Suggested and closed tasks', async () => {
    const fake = fakeTrilium({
      d: [periodNote('d', 'dateNote', '2026-11-06'), `<h2>Work</h2>${ul(li('e1', 'Fix <a href="https://example.atlassian.net/browse/QRS-9">QRS-9</a>'), li('e2', 'Done thing', { checked: true }))}<h2>Suggested</h2>${ul(li('s1', 'Get QRS-10 done'))}`],
    });
    const keys = liveKeys((await loadJournal(fake.api)).docs, new Date(2026, 10, 6, 12));
    expect(keys.get('QRS-9')).toEqual(['d/e1']);
    expect(keys.has('QRS-10')).toBe(false);
    expect(new Set([...keys.values()].flat())).toEqual(new Set(['d/e1']));
  });
});

/** The one key `keysOf` derives from `text`. */
function onlyKey(text: string): string {
  const [key] = keysOf(text);
  if (!key) throw new Error(`no key for "${text}"`);
  return key;
}
