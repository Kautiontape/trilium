import { describe, expect, it } from 'vitest';
import { critical, fakeTrilium, li, periodNote, ul } from '../trilium/helpers.js';
import { readPlan, type PlanTask } from '../trilium/plan-read.js';
import { dayLoad, liveMinutes } from './load.js';

const task = (over: Partial<PlanTask>): PlanTask => ({
  noteId: 'd', listItemId: null, state: 'open', text: 't', estMinutes: null, parent: null, parentListItemId: null,
  section: null, critical: false, area: 'foundation', block: null, at: null, ...over,
});

describe('liveMinutes', () => {
  it('counts a parent through its live sub-items and an unestimated task at 30', () => {
    const tasks = [
      task({ text: 'Parent', estMinutes: 90 }),
      task({ text: 'Step a', parent: 'Parent', estMinutes: 10 }),
      task({ text: 'Step b', parent: 'Parent' }),
      task({ text: 'Plain' }),
      task({ text: 'Done', state: 'done', estMinutes: 60 }),
      task({ text: '  ', estMinutes: 60 }),
    ];
    expect(liveMinutes(tasks)).toBe(10 + 30 + 30);
    expect(liveMinutes(tasks, 'growth')).toBe(0);
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
