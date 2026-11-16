import { describe, expect, it } from 'vitest';
import { critical, fakeTrilium, li, periodNote, ul } from '../trilium/helpers.js';
import { readPlan, type PlanTask } from '../trilium/plan-read.js';
import { countUnits, dayLoad, liveMinutes, parentsOf, unitMinutes } from './load.js';

const task = (over: Partial<PlanTask>): PlanTask => ({
  noteId: 'd', listItemId: null, state: 'open', text: 't', estMinutes: null, parent: null, parentListItemId: null,
  section: null, critical: false, area: 'foundation', block: null, at: null, ...over,
});

describe('liveMinutes', () => {
  it('counts a parent by its own estimate, a plain task at 30 when unestimated, and skips done and empty ones', () => {
    const tasks = [
      task({ text: 'Parent', estMinutes: 90 }),
      task({ text: 'Step a', parent: 'Parent', estMinutes: 10 }),
      task({ text: 'Step b', parent: 'Parent' }),
      task({ text: 'Plain' }),
      task({ text: 'Done', state: 'done', estMinutes: 60 }),
      task({ text: '  ', estMinutes: 60 }),
    ];
    expect(liveMinutes(tasks)).toBe(90 + 30);
    expect(liveMinutes(tasks, 'growth')).toBe(0);
  });

  it('counts a task of the same words as a parent by its own estimate, by row or by the nearest earlier one', () => {
    const byId = [
      task({ listItemId: 's1', text: 'Standup', estMinutes: 30 }),
      task({ listItemId: 's2', text: 'Standup' }),
      task({ listItemId: 's2a', text: 'Notes', parent: 'Standup', parentListItemId: 's2', estMinutes: 10 }),
    ];
    expect(liveMinutes(byId)).toBe(30 + 10);
    const idless = [
      task({ text: 'Standup', estMinutes: 30 }),
      task({ text: 'Standup' }),
      task({ text: 'Notes', parent: 'Standup', estMinutes: 10 }),
    ];
    expect(liveMinutes(idless)).toBe(30 + 10);
    const parents = parentsOf(idless);
    expect(parents.get(idless[2])).toBe(idless[1]);
    expect(parents.size).toBe(1);
    const otherNote = [task({ noteId: 'x', text: 'Standup' }), task({ noteId: 'y', text: 'Notes', parent: 'Standup' })];
    expect(parentsOf(otherNote).size).toBe(0);
  });

  it('equals the plan read\'s foundation minutes', async () => {
    const html =
      '<h3>Morning</h3>' + critical(li('c', 'Ship ~1h')) +
      ul(li('a', 'First ~30m'), li('b', 'Underway ~15m', { state: 'doing' }), li('c2', 'Learn', { sub: ul(li('c2a', 'Step ~10m')) }), li('d', 'Gone', { checked: true })) +
      '<h3>Growth</h3>' + ul(li('g', 'Read ~45m'));
    const f = fakeTrilium({ d: [periodNote('d', 'dateNote', '2026-10-26'), html] });
    const plan = await readPlan(f.api, 'day', '2026-10-26', new Date(2026, 9, 26));
    const tasks = [...plan.critical, ...plan.sections.flatMap((s) => s.tasks)];
    expect(plan.capacity.areas.foundation.minutes).toBeGreaterThan(0);
    expect(liveMinutes(tasks, 'foundation')).toBe(plan.capacity.areas.foundation.minutes);
    expect(liveMinutes(tasks, 'growth')).toBe(plan.capacity.areas.growth.minutes);
  });
});

describe('countUnits', () => {
  const sub = (text: string, parent: string, over: Partial<PlanTask> = {}) => task({ text, parent, ...over });

  it('counts a parent by its own estimate, else the sum of its live sub-items', () => {
    const own = [task({ text: 'Fix', estMinutes: 15 }), sub('a', 'Fix', { estMinutes: 10 }), sub('b', 'Fix', { estMinutes: 10 }), sub('c', 'Fix', { estMinutes: 10 })];
    expect(countUnits(own).map((u) => [u.task.text, u.minutes, u.estimated, u.unestimated])).toEqual([['Fix', 15, 1, 0]]);
    const summed = [task({ text: 'Fix' }), sub('a', 'Fix', { estMinutes: 10 }), sub('b', 'Fix')];
    expect(countUnits(summed).map((u) => [u.minutes, u.estimated, u.unestimated])).toEqual([[40, 1, 1]]);
    expect(unitMinutes(summed[0]!, summed)).toBe(40);
    expect(unitMinutes(summed[2]!, summed)).toBe(30);
    expect(unitMinutes(summed[1]!, summed)).toBe(10);
  });

  it('counts a hand-made deeper nest through its sub-items', () => {
    const tasks = [
      task({ listItemId: 'p', text: 'P' }),
      task({ listItemId: 'q', text: 'Q', parent: 'P', parentListItemId: 'p' }),
      task({ listItemId: 'r', text: 'R', parent: 'Q', parentListItemId: 'q', estMinutes: 5 }),
    ];
    expect(liveMinutes(tasks)).toBe(5);
  });

  it('counts a meeting parent as 0, but a pinned task without sub-items or a non-meeting parent as usual', () => {
    const meetings = ['09:30 Standup (Ana)', '11:00'];
    const standup = [task({ text: '9:30 Standup', at: '9:30', estMinutes: 20 }), sub('Notes', '9:30 Standup', { estMinutes: 10 })];
    expect(countUnits(standup, { meetings }).map((u) => [u.minutes, u.estimated, u.unestimated])).toEqual([[0, 0, 0]]);
    expect(liveMinutes([task({ text: '09:30 Standup', at: '09:30' })], undefined, { meetings })).toBe(30);
    const appointment = [task({ text: '10:30 Appointment', at: '10:30' }), sub('Bring ID', '10:30 Appointment', { estMinutes: 5 })];
    expect(liveMinutes(appointment, undefined, { meetings })).toBe(5);
  });

  it('counts a done parent\'s open sub-item on its own, in its own area', () => {
    const tasks = [task({ text: 'P', state: 'done', area: 'growth' }), sub('a', 'P', { estMinutes: 10, area: 'growth' })];
    expect(countUnits(tasks).map((u) => [u.task.text, u.minutes])).toEqual([['a', 10]]);
    expect(liveMinutes(tasks, 'growth')).toBe(10);
  });

  it('takes the parents map when given', () => {
    const tasks = [task({ text: 'X' }), task({ text: 'Y', estMinutes: 10 })];
    const parents = new Map([[tasks[1]!, tasks[0]!]]);
    expect(liveMinutes(tasks, undefined, { parents })).toBe(10);
  });
});

describe('dayLoad', () => {
  const limits = { focus: { min: 180, max: 240 }, growthTarget: { min: 60, max: 120 } };
  const load = (foundation: number, onDeck = 0, growth = 0, recharge = 0) => dayLoad({ foundation, onDeck, growth, recharge }, limits);

  it('is under below focus.max, at focus.max is not over, and over by the excess', () => {
    expect(load(200).foundation).toEqual({ minutes: 200, focus: { min: 180, max: 240 }, over: false, overMinutes: 0 });
    expect(load(240).foundation).toMatchObject({ over: false, overMinutes: 0 });
    expect(load(255).foundation).toMatchObject({ over: true, overMinutes: 15 });
  });

  it('keeps On deck out of over and reports how far over the day would be with it', () => {
    expect(load(230, 30).foundation.over).toBe(false);
    expect(load(230, 30).onDeck).toEqual({ minutes: 30, overWith: 20 });
    expect(load(100, 30).onDeck.overWith).toBe(0);
  });

  it('flags Growth over its max and counts Recharge', () => {
    expect(load(0, 0, 120).growth).toEqual({ minutes: 120, target: { min: 60, max: 120 }, over: false });
    expect(load(0, 0, 135, 2).growth.over).toBe(true);
    expect(load(0, 0, 0, 2).recharge).toEqual({ count: 2 });
  });
});
