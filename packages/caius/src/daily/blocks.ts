// The day's work laid out in time: the main list, group by group, in the gaps between meetings.

import { parseClock } from '../inputs/capacity.js';

export interface WorkTask {
  label: string;
  minutes: number;
  /** An evening task (under Evening or Recharge): it starts no earlier than the end of work. */
  evening?: boolean;
}

export interface WorkBlock {
  start: string;
  end: string;
  label: string;
}

/** A group laid out: from its first task's start to its last task's end, and how many tasks it holds. */
export interface GroupBlock {
  start: string;
  end: string;
  name: string;
  count: number;
  important?: true;
}

/**
 * Lays `tasks` out in order from `start`, or from `notBefore` when that is later (the time now, on
 * the day being planned), each in the earliest free time after the one before it, split across a
 * meeting when it has to be (only the first part carries the label), never past `end`. Evening tasks
 * start no earlier than `workEnd`. `unplaced` holds the minutes of each task that did not fit before `end`.
 */
export function layoutWork(
  day: { start: string; end: string; workEnd: string; notBefore?: string },
  meetings: { start: string; end: string }[],
  tasks: WorkTask[],
): { work: WorkBlock[]; unplaced: { label: string; minutes: number }[] } {
  const { work, unplaced } = placeTasks(day, meetings, tasks);
  return { work: work.map(({ task: _task, ...block }) => block), unplaced };
}

/**
 * Lays `groups` out as `layoutWork` lays out a list, group after group, and answers each group that
 * got time with its span and its count of tasks, as well as the blocks.
 */
export function layoutGroups(
  day: { start: string; end: string; workEnd: string; notBefore?: string },
  meetings: { start: string; end: string }[],
  groups: { name: string; important?: boolean; tasks: WorkTask[] }[],
): { groups: GroupBlock[]; work: WorkBlock[]; unplaced: { label: string; minutes: number }[] } {
  const tasks = groups.flatMap((group) => group.tasks);
  const { work, unplaced } = placeTasks(day, meetings, tasks);
  let first = 0;
  const blocks = groups.flatMap((group) => {
    const from = first;
    first += group.tasks.length;
    const own = work.filter((block) => block.task >= from && block.task < first);
    if (!own.length) return [];
    const start = own.map((block) => block.start).reduce((a, b) => (b < a ? b : a));
    const end = own.map((block) => block.end).reduce((a, b) => (b > a ? b : a));
    return [{ start, end, name: group.name, count: group.tasks.length, ...(group.important ? { important: true as const } : {}) }];
  });
  return { groups: blocks, work: work.map(({ task: _task, ...block }) => block), unplaced };
}

/** `layoutWork`'s blocks, each with the index of its task. */
function placeTasks(
  day: { start: string; end: string; workEnd: string; notBefore?: string },
  meetings: { start: string; end: string }[],
  tasks: WorkTask[],
): { work: (WorkBlock & { task: number })[]; unplaced: { label: string; minutes: number }[] } {
  const start = Math.max(parseClock(day.start) ?? 0, parseClock(day.notBefore ?? '') ?? 0);
  const end = parseClock(day.end) ?? 24 * 60;
  const workEnd = parseClock(day.workEnd) ?? end;
  const busy: [number, number][] = meetings
    .map((m): [number, number] => [parseClock(m.start) ?? 0, parseClock(m.end) ?? 0])
    .filter(([from, to]) => to > from);
  const work: (WorkBlock & { task: number })[] = [];
  const unplaced: { label: string; minutes: number }[] = [];
  let workCursor = start;
  let eveningCursor = Math.max(start, workEnd);

  for (const [index, task] of tasks.entries()) {
    let left = Math.max(0, Math.round(task.minutes));
    let at = task.evening ? Math.max(eveningCursor, workCursor) : workCursor;
    while (left > 0 && at < end) {
      const blocking = busy.filter(([from, to]) => to > at && from <= at);
      if (blocking.length) {
        at = Math.max(...blocking.map(([, to]) => to));
        continue;
      }
      const nextBusy = Math.min(end, ...busy.filter(([from]) => from > at).map(([from]) => from));
      const until = Math.min(nextBusy, at + left);
      // A task split around a meeting is labelled on its first part only, so it reads as one task.
      const first = !work.some((block) => block.task === index);
      work.push({ start: hhmm(at), end: hhmm(until), label: first ? task.label : '', task: index });
      busy.push([at, until]);
      left -= until - at;
      at = until;
    }
    if (left > 0) unplaced.push({ label: task.label, minutes: left });
    if (task.evening) eveningCursor = at;
    else {
      workCursor = at;
      eveningCursor = Math.max(eveningCursor, at);
    }
  }
  return { work, unplaced };
}

function hhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
