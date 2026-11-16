// The two rules that propose groupings in Plan my day: an ask under a meeting its asker is in, and a
// run of three tasks of one project under a parent named for it.

import { attendeeFirstName } from './meetings.js';

/** A timed meeting the user attends. `start` is `HH:MM`; the caller drops declined and all-day events. */
export interface NestMeeting {
  start: string;
  title: string;
  attendees: string[];
}

/**
 * A top-level task of the day's list. `subItem` is true for a sub-item (it can't be a parent or an
 * item); `hasSubItems` is true for a parent (it can be a nest's `under`, never an item).
 */
export interface NestTask {
  listItemId: string;
  ref?: string;
  text: string;
  at: string | null;
  keys: string[];
  subItem: boolean;
  hasSubItems: boolean;
  project?: { noteId: string; title: string } | null;
}

/** An ask from Jira. An offered candidate has `candidateId`, `ref` and `text`; otherwise only a list task naming `key` can be nested. */
export interface NestAsk {
  key: string;
  author: string;
  candidateId?: string;
  ref?: string;
  text?: string;
}

/** `id` is the list item id, or the candidate id for an ask not yet on the list. */
export interface NestItem {
  id: string;
  ref?: string;
  text: string;
}

export interface Nest {
  under: { listItemId: string; ref?: string; text: string } | { text: string };
  items: NestItem[];
  because: { kind: 'meeting'; meeting: string; askers: string[] } | { kind: 'project'; project: string; count: number };
}

export type NumberedNest = Nest & { ref: string };

/** Each meeting that has asks from its attendees: the asks go under the meeting's task, or a new `HH:MM Title` parent. */
export function meetingAskNests(meetings: NestMeeting[], list: NestTask[], asks: NestAsk[]): Nest[] {
  const sorted = [...meetings].sort((a, b) => a.start.localeCompare(b.start));
  const taken = new Set<string>();
  const claimed = new Set<NestAsk>();
  const starts = new Set(meetings.map((meeting) => meeting.start));
  const nests: Nest[] = [];
  for (const meeting of sorted) {
    const first = new Set(meeting.attendees.map(attendeeFirstName).filter(Boolean));
    const mine = asks.filter((ask) => first.has(firstWord(ask.author).toLowerCase()) && !claimed.has(ask));
    const held = list.find((task) => !task.subItem && task.at === meeting.start);
    const items: NestItem[] = [];
    const askers: string[] = [];
    for (const ask of mine) {
      const found: NestItem[] = [];
      if (ask.candidateId && !taken.has(ask.candidateId)) {
        found.push({ id: ask.candidateId, ref: ask.ref, text: ask.text ?? '' });
      }
      for (const task of list) {
        if (task.subItem || task.hasSubItems || (task.at !== null && starts.has(task.at)) || taken.has(task.listItemId)) continue;
        if (task.keys.includes(ask.key)) found.push({ id: task.listItemId, ref: task.ref, text: task.text });
      }
      claimed.add(ask);
      if (!found.length) continue;
      for (const item of found) taken.add(item.id);
      items.push(...found);
      const name = firstWord(ask.author);
      if (!askers.includes(name)) askers.push(name);
    }
    if (!items.length) continue;
    nests.push({
      under: held ? { listItemId: held.listItemId, ref: held.ref, text: held.text } : { text: `${meeting.start} ${meeting.title}` },
      items,
      because: { kind: 'meeting', meeting: meeting.title, askers },
    });
  }
  return nests;
}

/** Three or more plain tasks of one project, not in `used`, under a new parent named for the project. */
export function projectRunNests(list: NestTask[], used: Set<string> = new Set()): Nest[] {
  const runs = new Map<string, { title: string; tasks: NestTask[] }>();
  for (const task of list) {
    if (task.subItem || task.hasSubItems || used.has(task.listItemId) || !task.project) continue;
    const run = runs.get(task.project.noteId) ?? { title: task.project.title, tasks: [] };
    run.tasks.push(task);
    runs.set(task.project.noteId, run);
  }
  const nests: Nest[] = [];
  for (const run of runs.values()) {
    if (run.tasks.length < 3) continue;
    nests.push({
      under: { text: run.title },
      items: run.tasks.map((task) => ({ id: task.listItemId, ref: task.ref, text: task.text })),
      because: { kind: 'project', project: run.title, count: run.tasks.length },
    });
  }
  return nests;
}

/** The meeting nests, then the project runs over what is left, numbered `n1`, `n2`... in that order. */
export function planNests(meetings: NestMeeting[], list: NestTask[], asks: NestAsk[]): NumberedNest[] {
  const byMeeting = meetingAskNests(meetings, list, asks);
  const used = new Set(byMeeting.flatMap((nest) => nest.items.map((item) => item.id)));
  return [...byMeeting, ...projectRunNests(list, used)].map((nest, i) => ({ ...nest, ref: `n${i + 1}` }));
}

function firstWord(text: string): string {
  return text.trim().split(/\s+/)[0] ?? '';
}
