import { describe, it, expect } from 'vitest';
import { originIn, taskRef } from './origin-html.js';

const STATES = new Map([
  ['doing', '/'],
  ['cancelled', '-'],
  ['_rescheduled', '>'],
]);

const li = (id: string, text: string, o: { state?: string; sub?: string } = {}) =>
  `<li data-list-item-id="${id}"${o.state ? ` data-trilium-task-state="${o.state}"` : ''}>` +
  `<label class="todo-list__label"><input type="checkbox" disabled="disabled">` +
  `<span class="todo-list__label__description">${text}</span></label>${o.sub ?? ''}</li>`;
const ul = (...items: string[]) => `<ul class="todo-list">${items.join('')}</ul>`;

const MEETING =
  '<h2>Notes from the call</h2><p>They liked the pilot.</p>' +
  '<h2>Follow-ups</h2><p>Before the next call, get the numbers straight so the quote holds.</p>' +
  ul(
    li('m1', 'Count the seats across the two offices — replaces "2" everywhere <em>scheduled <a href="#root/oct">October</a></em>', { state: '_rescheduled' }),
    li('m2', 'Confirm the price per seat so the cap is a real figure'),
    li('m3', 'Check the unit cost against a test run'),
    li('m4', 'Pick a contract shape'),
    li('m5', 'Book the follow-up'),
  );

describe('taskRef', () => {
  it("gives a copy's words without its back link, scheduled note or estimate, and where the link points", () => {
    const html = ul(li('c1', 'Count the seats across the two offices — replaces "2" everywhere ~30m <a href="#root/meet">from 2026-08-11 Pilot call</a>'));
    expect(taskRef(html, 'c1')).toEqual({ text: 'Count the seats across the two offices — replaces "2" everywhere', from: 'meet' });
    expect(taskRef(ul(li('t1', 'Water the plants')), 't1')).toEqual({ text: 'Water the plants', from: null });
    expect(taskRef(ul(li('t1', 'Water the plants')), 'nope')).toBeNull();
  });
});

describe('originIn', () => {
  it('finds a meeting copy by its words: the headings, the nearest items and the paragraph before the list', () => {
    expect(originIn(MEETING, { text: 'Count the seats across the two offices — replaces "2" everywhere' }, STATES)).toEqual({
      headings: ['Follow-ups'],
      parent: null,
      neighbours: ['Confirm the price per seat so the cap is a real figure', 'Check the unit cost against a test run', 'Pick a contract shape'],
      lead: 'Before the next call, get the numbers straight so the quote holds.',
      matched: true,
    });
  });

  it('takes the items on both sides, the one after first, and the heading of each higher level above', () => {
    const html = '<h2>Work</h2><h3>This week</h3>' + ul(li('a', 'One'), li('b', 'Two'), li('c', 'Three'), li('d', 'Four'));
    expect(originIn(html, { id: 'c' }, STATES)).toMatchObject({ headings: ['Work', 'This week'], neighbours: ['Four', 'Two', 'One'], lead: null });
  });

  it("names a nested item's parent", () => {
    const html = '<h3>☑️ Tasks</h3>' + ul(li('p', 'Prepare the 2.0 release ~2h', { sub: ul(li('s1', 'Add a release type?'), li('s2', 'Write the notes')) }));
    expect(originIn(html, { id: 's1' }, STATES)).toEqual({ headings: ['☑️ Tasks'], parent: 'Prepare the 2.0 release', neighbours: ['Write the notes'], lead: null, matched: true });
  });

  it('says matched: false for a copy whose words changed', () => {
    expect(originIn(MEETING, { text: 'Count seats (both offices)' }, STATES)).toEqual({ headings: [], parent: null, neighbours: [], lead: null, matched: false });
  });

  it('prefers the rescheduled item of two with the same words', () => {
    const html = '<h3>Earlier</h3>' + ul(li('x', 'Send the invoice')) + '<h3>Later</h3>' + ul(li('y', 'Send the invoice', { state: '_rescheduled' }), li('z', 'Chase the bank'));
    expect(originIn(html, { text: 'send the invoice' }, STATES)).toMatchObject({ headings: ['Later'], neighbours: ['Chase the bank'] });
  });

  it('describes a task written where it is, found by its id, and cuts a long lead', () => {
    const long = 'word '.repeat(60).trim();
    const html = `<h3>Work</h3><p>${long}</p><p></p>` + ul(li('t1', 'Water the plants'));
    const origin = originIn(html, { id: 't1' }, STATES);
    expect(origin).toMatchObject({ headings: ['Work'], parent: null, neighbours: [], matched: true });
    expect(origin.lead!.length).toBeLessThanOrEqual(201);
    expect(origin.lead!.endsWith('word…')).toBe(true);
  });
});
