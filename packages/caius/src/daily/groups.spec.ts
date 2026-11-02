import { describe, expect, it } from 'vitest';
import { groupTasks, meetingName, shortName } from './groups.js';

const task = (id: string | null, section: string | null = 'Work', critical = false) => ({ id, section, critical });

describe('groupTasks', () => {
  it('keeps the saved groups, in the order of their first task, each task in list order', () => {
    const list = [task('a'), task('b'), task('c'), task('d', null, true)];
    const groups = groupTasks(list, [
      { name: 'ZAP bugs', items: ['b', 'c'] },
      { name: 'Board', items: ['a', 'd'] },
    ]);
    expect(groups.map((g) => [g.name, g.tasks.map((t) => t.id), g.important])).toEqual([
      ['Board', ['a', 'd'], true],
      ['ZAP bugs', ['b', 'c'], false],
    ]);
  });

  it('puts a task no group names in the group of the task above it, or the first group when it is first', () => {
    const groups = groupTasks([task('new1'), task('a'), task('new2'), task(null), task('b')], [
      { name: 'Board', items: ['a'] },
      { name: 'Calls', items: ['b'] },
    ]);
    expect(groups.map((g) => [g.name, g.tasks.map((t) => t.id)])).toEqual([
      ['Board', ['new1', 'a', 'new2', null]],
      ['Calls', ['b']],
    ]);
  });

  it('drops a group none of whose tasks are left, and an id named twice stays in its first group', () => {
    const groups = groupTasks([task('a'), task('b')], [
      { name: 'Gone', items: ['x'] },
      { name: 'Board', items: ['a', 'b'] },
      { name: 'Calls', items: ['b'] },
    ]);
    expect(groups.map((g) => [g.name, g.tasks.map((t) => t.id)])).toEqual([['Board', ['a', 'b']]]);
  });

  it('groups by heading without saved groups, each name cut to ten characters at a word', () => {
    const groups = groupTasks([task('a', 'Morning routine'), task('b', '☑️ Work'), task('c', 'Morning routine'), task('d', null, true), task('e', null), task('f', 'ticket review'), task('g', 'Housekeeping')], null);
    expect(groups.map((g) => [g.name, g.tasks.map((t) => t.id)])).toEqual([
      ['Morning', ['a', 'c']],
      ['Work', ['b']],
      ['Important', ['d']],
      ['Tasks', ['e']],
      ['ticket', ['f']],
      ['Housekeepi', ['g']],
    ]);
    expect(groupTasks([], [])).toEqual([]);
  });

  it('cuts a name to ten characters, whole characters', () => {
    expect(shortName('  Sec. fixes  ')).toBe('Sec. fixes');
    expect(shortName('Security fixes')).toBe('Security f');
    expect(shortName('Réunions 🙂 du jour')).toBe('Réunions 🙂');
  });

  it('names a meeting by the name given for its title, or for a line that holds it, else its title cut to fit at a word', () => {
    const meetings = [{ title: 'ZI <> TresAlly Daily Standup', name: 'Standup' }];
    expect(meetingName('ZI <> TresAlly Daily Standup', meetings)).toBe('Standup');
    expect(meetingName('ZI <> TresAlly Daily Standup (Sasha, Chris)', meetings)).toBe('Standup');
    expect(meetingName('Sprint planning', meetings)).toBe('Sprint');
    expect(meetingName('Architecture review', meetings)).toBe('Architectu');
    expect(meetingName('', meetings)).toBe('');
  });
});
