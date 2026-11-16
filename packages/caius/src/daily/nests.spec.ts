import { describe, expect, it } from 'vitest';
import { meetingAskNests, planNests, projectRunNests, type NestAsk, type NestMeeting, type NestTask } from './nests.js';

const task = (id: string, o: Partial<NestTask> = {}): NestTask => ({
  listItemId: id, text: `Task ${id}`, at: null, keys: [], subItem: false, hasSubItems: false, ...o,
});
const standup: NestMeeting = { start: '09:30', title: 'Standup', attendees: ['ana.lopez@example.com', 'Ben Ortiz'] };
const ask = (key: string, author: string, o: Partial<NestAsk> = {}): NestAsk => ({ key, author, ...o });

describe('meetingAskNests', () => {
  it('puts an ask candidate and a list task naming its key under the standup task', () => {
    const list = [task('s', { text: '09:30 Standup', at: '09:30' }), task('t1', { keys: ['ABC-12'] }), task('t2')];
    const nests = meetingAskNests([standup], list, [
      ask('ABC-12', 'Ana Lopez', { candidateId: 'c1', ref: 'a1', text: 'Answer ABC-12' }),
    ]);
    expect(nests).toEqual([{
      under: { listItemId: 's', ref: undefined, text: '09:30 Standup' },
      items: [{ id: 'c1', ref: 'a1', text: 'Answer ABC-12' }, { id: 't1', ref: undefined, text: 'Task t1' }],
      because: { kind: 'meeting', meeting: 'Standup', askers: ['Ana'] },
    }]);
  });

  it('makes no nest when no attendee matches, and a new parent when no task holds the meeting', () => {
    const c = ask('ABC-12', 'Cy Park', { candidateId: 'c1', text: 'x' });
    expect(meetingAskNests([standup], [], [c])).toEqual([]);
    const [nest] = meetingAskNests([standup], [], [ask('ABC-12', 'Ben Ortiz', { candidateId: 'c1', text: 'x' })]);
    expect(nest?.under).toEqual({ text: '09:30 Standup' });
    expect(nest?.because).toEqual({ kind: 'meeting', meeting: 'Standup', askers: ['Ben'] });
  });

  it('sends an asker in two meetings to the earlier one and skips nested tasks', () => {
    const later: NestMeeting = { start: '11:00', title: 'Sync', attendees: ['Ana Lopez'] };
    const list = [task('a', { keys: ['ABC-1'], subItem: true }), task('b', { keys: ['ABC-1'], hasSubItems: true }), task('s', { at: '09:30', hasSubItems: true })];
    const nests = meetingAskNests([later, standup], list, [ask('ABC-1', 'Ana Lopez', { candidateId: 'c1', text: 'x' })]);
    expect(nests).toHaveLength(1);
    expect(nests[0]?.under).toMatchObject({ listItemId: 's' });
    expect(nests[0]?.items.map((i) => i.id)).toEqual(['c1']);
  });
});

describe('meetingAskNests, edge cases', () => {
  it("never takes another meeting's own task as an item", () => {
    const review: NestMeeting = { start: '14:00', title: 'Review', attendees: ['Cy Park'] };
    const list = [task('s', { at: '09:30' }), task('r', { at: '14:00', keys: ['ABC-12'] })];
    expect(meetingAskNests([standup, review], list, [ask('ABC-12', 'Ana Lopez')])).toEqual([]);
  });

  it('adds no item and no asker for an ask with no candidate and no task naming it', () => {
    const list = [task('t1', { keys: ['ABC-12'] })];
    const [nest] = meetingAskNests([standup], list, [ask('ABC-99', 'Ben Ortiz'), ask('ABC-12', 'Ana Lopez')]);
    expect(nest?.because).toEqual({ kind: 'meeting', meeting: 'Standup', askers: ['Ana'] });
    expect(meetingAskNests([standup], list, [ask('ABC-99', 'Ben Ortiz')])).toEqual([]);
  });
});

describe('projectRunNests', () => {
  const p = { noteId: 'p1', title: 'Caius' };
  it('nests three or more tasks of one project under its title, and not two', () => {
    const list = [task('a', { project: p }), task('b', { project: p }), task('c', { project: p }), task('d', { project: { noteId: 'p2', title: 'Other' } })];
    expect(projectRunNests(list)).toEqual([{
      under: { text: 'Caius' },
      items: [{ id: 'a', ref: undefined, text: 'Task a' }, { id: 'b', ref: undefined, text: 'Task b' }, { id: 'c', ref: undefined, text: 'Task c' }],
      because: { kind: 'project', project: 'Caius', count: 3 },
    }]);
    expect(projectRunNests(list.slice(0, 2))).toEqual([]);
  });

  it('leaves out nested tasks and used ids', () => {
    const list = [task('a', { project: p }), task('b', { project: p }), task('c', { project: p, subItem: true }), task('d', { project: p, hasSubItems: true })];
    expect(projectRunNests(list)).toEqual([]);
    const four = [...list.slice(0, 2), task('e', { project: p }), task('f', { project: p })];
    expect(projectRunNests(four, new Set(['a']))).toHaveLength(1);
    expect(projectRunNests(four, new Set(['a', 'b']))).toEqual([]);
  });
});

describe('planNests', () => {
  it('numbers the nests and keeps an item out of a second one', () => {
    const p = { noteId: 'p1', title: 'Caius' };
    const list = [task('s', { at: '09:30' }), task('a', { project: p, keys: ['ABC-1'] }), task('b', { project: p }), task('c', { project: p }), task('d', { project: p })];
    const nests = planNests([standup], list, [ask('ABC-1', 'Ana Lopez')]);
    expect(nests.map((n) => n.ref)).toEqual(['n1', 'n2']);
    expect(nests[0]?.items.map((i) => i.id)).toEqual(['a']);
    expect(nests[1]?.items.map((i) => i.id)).toEqual(['b', 'c', 'd']);
  });
});
