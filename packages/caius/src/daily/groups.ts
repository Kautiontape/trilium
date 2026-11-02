// The day's groups: the main list cut into the few named runs of work the drawing shows as hills.

/** The most characters a group's or a meeting's name on the drawing may have. */
export const NAME_LENGTH = 10;

/** A group as kept on the brief: its name and the listItemIds of its tasks. */
export interface SavedGroup {
  name: string;
  items: string[];
}

export interface GroupedTask {
  /** The task's listItemId; a task without one joins by its place. */
  id: string | null;
  /** The heading it sits under, which names the groups of a brief that kept none. */
  section: string | null;
  /** In the day note's Important block. */
  critical?: boolean;
}

export interface TaskGroup<T> {
  name: string;
  tasks: T[];
  /** It holds a task of the Important block. */
  important: boolean;
}

/**
 * `tasks`, the main list in order, in the groups `saved` names. A task no group names joins the
 * group of the task just above it, or the first group when it is first; a group none of whose tasks
 * are left is gone. Without saved groups, the tasks under each heading are one group, named by the
 * heading cut to fit at a word. Groups come in the order of their first task on the list, their tasks in list order.
 */
export function groupTasks<T extends GroupedTask>(tasks: T[], saved: SavedGroup[] | null | undefined): TaskGroup<T>[] {
  const named = (saved ?? []).filter((group) => group.name.trim() !== '');
  const indexOf = new Map<string, number>();
  named.forEach((group, i) => group.items.forEach((id) => indexOf.has(id) || indexOf.set(id, i)));
  const headings: string[] = [];
  const groupOf = (task: T, above: number | undefined): number => {
    if (named.length) return (task.id !== null ? indexOf.get(task.id) : undefined) ?? above ?? 0;
    // A heading's emoji or marks before its first word ("☑️ Tasks") aren't part of its name.
    const heading = fitName((task.section ?? '').replace(/^[^\p{L}\p{N}]+/u, '')) || (task.critical ? 'Important' : 'Tasks');
    const at = headings.indexOf(heading);
    return at >= 0 ? at : headings.push(heading) - 1;
  };
  const members = new Map<number, T[]>();
  let above: number | undefined;
  for (const task of tasks) {
    const at = groupOf(task, above);
    members.set(at, [...(members.get(at) ?? []), task]);
    above = at;
  }
  // A Map keeps the order its keys were first set: the order of each group's first task.
  return [...members].map(([at, grouped]) => ({
    name: named.length ? shortName(named[at]?.name ?? '') : (headings[at] ?? ''),
    tasks: grouped,
    important: grouped.some((task) => !!task.critical),
  }));
}

/** `name` trimmed and cut to `NAME_LENGTH` characters. */
export function shortName(name: string): string {
  return [...name.trim()].slice(0, NAME_LENGTH).join('').trim();
}

/**
 * A meeting's name on the drawing: the short name `meetings` gives its title (or a title that holds
 * it, or one it holds, as a Meetings block line holds the calendar's), else its title cut to fit at a
 * word ("Release call" reads "Release").
 */
export function meetingName(title: string, meetings: { title: string; name: string }[] = []): string {
  const same = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();
  const it = same(title);
  const named =
    meetings.find((m) => m.title === title) ??
    meetings.find((m) => it !== '' && same(m.title) !== '' && (same(m.title).includes(it) || it.includes(same(m.title))));
  return named ? shortName(named.name) : fitName(title);
}

/** `text` cut to `NAME_LENGTH` characters at a word ("ticket review" reads "ticket"), or mid-word when its first word is longer. */
function fitName(text: string): string {
  let fit = '';
  for (const word of text.trim().split(/\s+/)) {
    const next = fit ? `${fit} ${word}` : word;
    if ([...next].length > NAME_LENGTH) break;
    fit = next;
  }
  return fit || shortName(text);
}
