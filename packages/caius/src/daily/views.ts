// What `caius_show` answers: the data of each view the phone draws. Types only, shared by the
// server that builds them and the phone that draws them.

import type { Area } from '../trilium/areas.js';
import type { TaskOrigin } from '../trilium/origin-html.js';
import type { PeriodKind, PlanTask } from '../trilium/plan-read.js';
import type { SavedGroup } from './groups.js';
import type { DayLoad } from './load.js';

export type ViewName = 'day' | 'days' | 'item' | 'slipping';

/** A `caius_show` result: the view, its heading, its data and its figures in one line for a client that draws no views. */
export type ShownView =
  | { view: 'day'; title: string; sentence: string; data: DayViewData }
  | { view: 'days'; title: string; sentence: string; data: DaysViewData }
  | { view: 'item'; title: string; sentence: string; data: ItemViewData }
  | { view: 'slipping'; title: string; sentence: string; data: SlippingViewData };

/**
 * A task as a view's row shows it: the plan's task with where it sits and what the views add.
 * `ref` is `withRefs`'s, prefix `v`, so Caius finds the row in the result it already has.
 */
export interface ViewTask extends Pick<PlanTask, 'noteId' | 'state' | 'text' | 'estMinutes' | 'parent' | 'parentListItemId' | 'section' | 'critical' | 'area' | 'block' | 'at'> {
  listItemId: string;
  ref: string;
  /** The note's period kind and key: `day` `2026-11-03`, `week` `2026-W45`, `month` `2026-11`. */
  period: { kind: PeriodKind; key: string };
  /** The list proper or On deck; anything else (Suggested) is not shown. */
  place: 'list' | 'onDeck';
  /** Moves off day notes (`slipsOf`). */
  slips: number;
  /** The first ticket key the task names, with its Jira status when it was read. */
  ticket?: { key: string; status?: string };
}

export interface ViewMeeting {
  start: string;
  end: string;
  title: string;
  allDay?: true;
}

export interface ViewContextLine {
  text: string;
  /** `YYYY-MM-DD`, when the line has an `(until …)`. */
  until?: string;
  untilLabel?: string;
}

/** The day's edges from the Rhythm, `HH:MM`: what the drawing and `layoutGroups` lay the day out in. */
export interface ViewSpan {
  start: string;
  noon: string;
  workEnd: string;
  /** Bedtime: the end of the drawing. */
  end: string;
}

export interface DayViewData {
  date: string;
  dateLabel: string;
  /** The area the view opens on: the one asked for, else the one that is over, else null. */
  openOn: Area | null;
  load: DayLoad;
  /** The calendar couldn't be read, so the focus is the stated or the Rhythm's one, not the meetings'. */
  calendarFailed: boolean;
  capacity: { windowMinutes: number; bookedMinutes: number; openMinutes: number };
  span: ViewSpan;
  meetings: ViewMeeting[];
  /** The brief's groups and meeting names, as `caius_plan`'s `drawn` gives them; null without a brief. */
  drawn: { groups: SavedGroup[]; meetings: { title: string; name: string }[] } | null;
  /** The minutes of work that don't fit before bedtime, as the server laid the day out. */
  unplacedMinutes: number;
  /** The list (the Important block first, then in order) and On deck, live top-level tasks and their live sub-items. */
  tasks: ViewTask[];
  /** The Context lines in force on the day. */
  context: ViewContextLine[];
}

/** One day of Days: its figures, and its rows for a tapped cell. A future day with no note has meetings and nothing else. */
export interface DaysViewDay {
  date: string;
  dateLabel: string;
  workday: boolean;
  meetingMinutes: number;
  load: DayLoad;
  calendarFailed: boolean;
  tasks: ViewTask[];
}

export interface DaysViewData {
  from: string;
  days: DaysViewDay[];
  week: {
    key: string;
    label: string;
    /** The week note's live items not yet on a day. */
    tasks: ViewTask[];
    /** The week's Foundation minutes (its own items and its days' lists) against the week target. */
    foundation: { minutes: number; target: { min: number; max: number } };
  };
}

/** One copy of a task on its trail, oldest first. */
export interface ViewTrailStep {
  period: { kind: PeriodKind; key: string };
  label: string;
  /** Moved on from there; false is where the task is now. */
  movedOn: boolean;
  state: string;
}

export interface ViewTicket {
  key: string;
  summary: string;
  status: string;
  daysInStatus: number | null;
  assignee: string | null;
  url: string;
  done: boolean;
  lastComment: { author: string; created: string; excerpt: string } | null;
  /** The latest comment that asks Shawn something, when there is one. */
  ask: { author: string; created: string; excerpt: string } | null;
}

export interface ItemViewData {
  /** The task, or null for a ticket no task names. */
  task: ViewTask | null;
  trail: ViewTrailStep[];
  origin: TaskOrigin | null;
  /** The ticket card; a `{ key, error }` when Jira couldn't be read for it. */
  ticket: ViewTicket | { key: string; error: string } | null;
  /** The Context lines in force that name the key. */
  context: ViewContextLine[];
  /** What Shawn said about the key lately: dismissed, finished or not today, with until when. */
  dispositions: { kind: 'dismissed' | 'finished' | 'not_today'; until?: string }[];
  /** For a ticket with no task: the days it can be taken to. */
  today: string;
  nextWorkday: string;
  week: string;
}

export interface SlippingViewData {
  /** Live tasks with 2 moves or more, the longest trail first. */
  tasks: ViewTask[];
  /** The overdue lane's count by how late. */
  overdue: { underWeek: number; oneToTwoWeeks: number; older: number };
  /** The month Park sends a task to. */
  parkMonth: string;
}
