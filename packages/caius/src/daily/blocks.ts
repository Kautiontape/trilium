// The work bars of the day's drawing: the main list laid out in order in the gaps between meetings.

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
  focus?: true;
}

/**
 * Lays `tasks` out in order from `start`, or from `notBefore` when that is later (the time now, on
 * the day being planned), each in the earliest free time after the one before it, split across a
 * meeting when it has to be (only the first part carries the label), never past `end`. Evening tasks start no earlier than `workEnd`. The first block of the first work task is the focus block; a day of
 * evening tasks only has none. `unplaced` holds the minutes of each task that did not fit before `end`.
 */
export function layoutWork(
  day: { start: string; end: string; workEnd: string; notBefore?: string },
  meetings: { start: string; end: string }[],
  tasks: WorkTask[],
): { work: WorkBlock[]; unplaced: { label: string; minutes: number }[] } {
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

  const firstWork = tasks.findIndex((task) => !task.evening);
  const focus = firstWork < 0 ? -1 : work.findIndex((block) => block.task === firstWork);
  return {
    work: work.map(({ task: _task, ...block }, i) => (i === focus ? { ...block, focus: true as const } : block)),
    unplaced,
  };
}

function hhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
