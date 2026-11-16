import { describe, it, expect } from 'vitest';
import { parse } from 'node-html-parser';
import { li, STATES, ul } from './helpers.js';
import { rewordTask } from './reword-html.js';

const spanOf = (html: string, id: string) =>
  parse(html).querySelectorAll('li').find((l) => l.getAttribute('data-list-item-id') === id)?.querySelector('span.todo-list__label__description')?.innerHTML;
const doc = (...items: string[]) => `<h2>Tasks</h2>${ul(...items)}`;
const FROM = '<a href="#root/n1">from Fri 13 Nov</a>';
const SCHED = '<em>scheduled <a href="#root/n2">Tue 17 Nov</a></em>';
const JIRA = '<a href="https://jira.example.com/browse/ABC-12">ABC-12</a>';

describe('rewordTask', () => {
  it('keeps the marker, the from link, the estimate and a scheduled trail around the new words', () => {
    const html = doc(
      li('t1', `🌱 Write the draft ${FROM} ~30m`),
      li('t2', `Send the note ${SCHED}`, { checked: true }),
    );
    const a = rewordTask(html, 't1', 'Draft the outline', STATES);
    expect(a).toMatchObject({ ok: true, unchanged: false, dropped: [], droppedKeys: [] });
    expect(a.ok && spanOf(a.html, 't1')).toBe(`🌱 Draft the outline ${FROM} ~30m`);
    const b = rewordTask(html, 't2', 'Send the summary', STATES);
    expect(b.ok && spanOf(b.html, 't2')).toBe(`Send the summary ${SCHED}`);
    expect(b.ok && b.html).toContain('checked="checked"');
  });

  it('keeps a clock unless the new words bring one', () => {
    const html = doc(li('t1', '09:00 standup ~15m'), li('t2', '🔋 09:00 standup'));
    const kept = rewordTask(html, 't1', 'Daily standup', STATES);
    expect(kept.ok && spanOf(kept.html, 't1')).toBe('09:00 Daily standup ~15m');
    const swapped = rewordTask(html, 't1', '10:30 Standup with Ana', STATES);
    expect(swapped.ok && spanOf(swapped.html, 't1')).toBe('10:30 Standup with Ana ~15m');
    const marked = rewordTask(html, 't2', '10:30 Standup with Ana', STATES);
    expect(marked.ok && spanOf(marked.html, 't2')).toBe('🔋 10:30 Standup with Ana');
  });

  it('keeps the id, state and checkbox of a doing and a done task, and the sub-items', () => {
    const sub = ul(li('s1', 'Part one ~10m'));
    const html = doc(
      li('t1', 'Old words', { state: 'doing', sub }),
      li('t2', 'Old done', { checked: true }),
    );
    const a = rewordTask(html, 't1', 'New words', STATES);
    expect(a.ok && a.html).toBe(doc(li('t1', 'New words', { state: 'doing', sub }), li('t2', 'Old done', { checked: true })));
    const b = rewordTask(html, 't2', 'New done', STATES);
    expect(b.ok && b.html).toBe(doc(li('t1', 'Old words', { state: 'doing', sub }), li('t2', 'New done', { checked: true })));
  });

  it('keeps a link on its text and reports one whose text is gone, with its key', () => {
    const html = doc(li('t1', `Check ${JIRA} export ~1h`), li('t2', 'Plain words'));
    const kept = rewordTask(html, 't1', 'ABC-12 export for Ana', STATES);
    expect(kept).toMatchObject({ ok: true, dropped: [], droppedKeys: [] });
    expect(kept.ok && spanOf(kept.html, 't1')).toBe(`${JIRA} export for Ana ~1h`);
    const gone = rewordTask(html, 't1', 'Export for Ana', STATES);
    expect(gone).toMatchObject({
      ok: true,
      dropped: [{ text: 'ABC-12', href: 'https://jira.example.com/browse/ABC-12' }],
      droppedKeys: ['ABC-12'],
    });
    expect(gone.ok && spanOf(gone.html, 't1')).toBe('Export for Ana ~1h');
    expect(rewordTask(html, 't2', 'Other words', STATES)).toMatchObject({ ok: true, droppedKeys: [] });
  });

  it('claims each link text once, in order', () => {
    const a = '<a href="https://example.com/a">Ana</a>';
    const html = doc(li('t1', `Ask ${a} and ${a}`));
    const r = rewordTask(html, 't1', 'Ana asks Ana', STATES);
    expect(r.ok && spanOf(r.html, 't1')).toBe(`${a} asks ${a}`);
  });

  it('escapes the new words', () => {
    const r = rewordTask(doc(li('t1', 'Old')), 't1', 'Q&A <draft> ~5m', STATES);
    expect(r.ok && spanOf(r.html, 't1')).toBe('Q&amp;A &lt;draft&gt;');
  });

  it('reads CKEditor spaces and strips a marker and an estimate from the new words', () => {
    const html = doc(li('t1', '🌱&nbsp;Words&nbsp;~30m'));
    const r = rewordTask(html, 't1', '🔋 Fresh words ~45m', STATES);
    expect(r.ok && spanOf(r.html, 't1')).toBe('🌱&nbsp;Fresh words&nbsp;~30m');
  });

  it('refuses what cannot be reworded', () => {
    const live = li('t1', 'Live');
    const html =
      `<h2>Tasks</h2>${ul(live, li('r1', 'Moved', { state: '_rescheduled' }), li('c1', 'Gone', { state: 'cancelled' }))}` +
      `<h3>Meetings</h3>${ul(li('m1', 'Standup'))}<h2>Context</h2>${ul(li('x1', 'Notes'))}` +
      `<h2>Suggested</h2>${ul(li('g1', 'Get it done'))}`;
    const reason = (id: string, text = 'New') => {
      const r = rewordTask(html, id, text, STATES);
      return r.ok ? 'ok' : r.reason;
    };
    expect(['nope', 'm1', 'x1', 'g1', 'r1', 'c1'].map((id) => reason(id))).toEqual(['not_found', 'not_live', 'not_live', 'suggested', 'moved', 'cancelled']);
    expect(reason('t1', '🌱 ~30m')).toBe('empty');
    expect(reason('t1', '   ')).toBe('empty');
  });

  it('keeps the estimate when the words hold an escaped < or >', () => {
    const html = doc(li('t1', 'Migrate A -&gt; B ~30m'));
    const r = rewordTask(html, 't1', 'Migrate A to B', STATES);
    expect(r.ok && spanOf(r.html, 't1')).toBe('Migrate A to B ~30m');
  });

  it('reports unchanged for the same words', () => {
    const html = doc(li('t1', `🌱 09:00 Same words ${FROM} ~30m`));
    const r = rewordTask(html, 't1', 'Same words', STATES);
    expect(r).toEqual({ ok: true, html, unchanged: true, dropped: [], droppedKeys: [] });
  });
});
