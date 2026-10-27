import type { ParsedTask } from './types.js';
import { parseTaskLine } from './parse-line.js';

const DEFAULT_TAB_WIDTH = 4;

/** Leading-whitespace width in columns, expanding tabs to tab stops. */
function indentColumns(line: string, tabWidth: number): number {
  let col = 0;
  for (const ch of line) {
    if (ch === ' ') col += 1;
    else if (ch === '\t') col += tabWidth - (col % tabWidth);
    else break;
  }
  return col;
}

/**
 * Parse a document into task blocks (§3.6). Returns every task (incl. subtasks)
 * in source order, each linked to its enclosing task via `parentLine`. Non-task
 * lines nested under a task are attached as `notes`; blank lines never break a
 * block.
 */
export function parseDocument(text: string, opts: { tabWidth?: number } = {}): ParsedTask[] {
  const tabWidth = opts.tabWidth ?? DEFAULT_TAB_WIDTH;
  const lines = text.split('\n');
  const tasks: ParsedTask[] = [];
  const stack: { indent: number; task: ParsedTask }[] = [];

  lines.forEach((raw, line) => {
    if (raw.trim() === '') return; // blank lines never break a block
    const indent = indentColumns(raw, tabWidth);
    const parsed = parseTaskLine(raw);

    if (parsed) {
      while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
      const parentLine = stack.length ? stack[stack.length - 1]!.task.line : null;
      const task: ParsedTask = { ...parsed, line, indent, parentLine, notes: [] };
      tasks.push(task);
      stack.push({ indent, task });
    } else {
      // a note attaches to the nearest enclosing task strictly shallower than it
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]!.indent < indent) {
          stack[i]!.task.notes.push(raw.trim());
          break;
        }
      }
    }
  });

  return tasks;
}
