// Trilium text-note HTML → the markdown lines `@caius/core` parses.
//
// Mirrors the Trilium fork's own export rule (trilium-core export/markdown.ts,
// buildListItemFilter): a todo-list item's `data-trilium-task-state` picks its
// symbol, otherwise the checkbox does. Two differences, both for the parser's
// sake: text is not markdown-escaped (a literal `[>]` typed into a plain list
// stays a task marker, and `~`/`!` tokens stay tokens), and a nested list sits
// directly under its parent line with no blank line between.

import TurndownService from 'turndown';

/** Task state id (the `stateId` label) → its single-character markdown symbol. */
export type StateSymbols = ReadonlyMap<string, string>;

/** The fork's seeded custom states; used when the live `_taskStates` can't be read. */
export const DEFAULT_STATE_SYMBOLS: StateSymbols = new Map([
  ['doing', '/'],
  ['maybe', '?'],
  ['cancelled', '-'],
]);

const INDENT = '    '; // matches DEFAULT_CONFIG.indent.tab_width

// A list item's Trilium id rides through turndown as a private-use sentinel right
// after its bullet, then is peeled off into a line → id side map. The markdown the
// parser sees never contains it, and no Caius `^id` is involved (D5).
const ID_OPEN = '\uE000';
const ID_CLOSE = '\uE001';
const ID_MARK = new RegExp(`${ID_OPEN}([^${ID_CLOSE}]*)${ID_CLOSE}`, 'g');
// Marks a list item inside an Important block; becomes a trailing `!!!` token on its line.
const CRIT = '\uE002';

export interface MarkdownWithIds {
  markdown: string;
  /** 0-based markdown line → the `data-list-item-id` of the `<li>` that produced it. */
  itemIds: Map<number, string>;
  /**
   * 0-based lines of tasks inside an Important block (`<aside class="admonition important">`).
   * Each of those lines also ends in a `!!!` token in `markdown`, so the parser sees tier 3;
   * nothing is ever written back to the note.
   */
  critical: Set<number>;
}

export function htmlToMarkdown(html: string, states: StateSymbols = DEFAULT_STATE_SYMBOLS): string {
  return htmlToMarkdownWithIds(html, states).markdown;
}

export function htmlToMarkdownWithIds(html: string, states: StateSymbols = DEFAULT_STATE_SYMBOLS): MarkdownWithIds {
  const raw = convert(html, states);
  const itemIds = new Map<number, string>();
  const critical = new Set<number>();
  const lines = raw.split('\n').map((line, i) => {
    const m = new RegExp(ID_MARK.source).exec(line);
    if (m?.[1]) itemIds.set(i, m[1]);
    let out = line.replace(ID_MARK, '');
    if (out.includes(CRIT)) {
      critical.add(i);
      out = out.replace(CRIT, '').replace(/(?:\s+!{1,3})?\s*$/, ' !!!');
    }
    return out;
  });
  return { markdown: lines.join('\n'), itemIds, critical };
}

function convert(html: string, states: StateSymbols): string {
  const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-' });
  td.escape = (text: string) => text;

  td.addRule('listItem', {
    filter: 'li',
    replacement(content, node) {
      const li = node as HTMLElement;
      const parent = li.parentNode as HTMLElement | null;
      const body = content
        .replace(/^\n+/, '')
        .replace(/\n+$/, '')
        .replace(/\n{2,}/g, '\n')
        .replace(/\n/g, `\n${INDENT}`);

      let prefix = '- ';
      if (parent?.nodeName === 'OL') {
        const start = Number(parent.getAttribute('start') ?? 1);
        prefix = `${start + Array.prototype.indexOf.call(parent.children, li)}. `;
      } else if (/\btodo-list\b/.test(parent?.getAttribute('class') ?? '')) {
        const state = li.getAttribute('data-trilium-task-state');
        const symbol = state ? states.get(state) : undefined;
        if (symbol) prefix = `- [${symbol}] `;
        else prefix = ownCheckboxChecked(li) ? '- [x] ' : '- [ ] ';
      }
      const id = li.getAttribute('data-list-item-id');
      const mark = id ? `${ID_OPEN}${id}${ID_CLOSE}` : '';
      return `${prefix}${mark}${inImportantBlock(li) ? CRIT : ''}${body}\n`;
    },
  });

  // A list directly inside a list item: no blank lines around it.
  td.addRule('nestedList', {
    filter: (node) => (node.nodeName === 'UL' || node.nodeName === 'OL') && node.parentNode?.nodeName === 'LI',
    replacement: (content) => `\n${content.replace(/\n+$/, '')}`,
  });

  return td.turndown(html);
}

/** The item's own checkbox (in its label), not one in a nested sub-list. */
function ownCheckboxChecked(li: HTMLElement): boolean {
  for (const child of Array.from(li.children)) {
    if (child.nodeName !== 'LABEL') continue;
    const input = child.querySelector('input[type=checkbox]');
    return input?.hasAttribute('checked') ?? false;
  }
  return false;
}

/** Inside an Important admonition block (Trilium's `aside.admonition.important`). */
function inImportantBlock(li: HTMLElement): boolean {
  for (let n = li.parentNode as HTMLElement | null; n; n = n.parentNode as HTMLElement | null) {
    if (n.nodeName !== 'ASIDE') continue;
    const classes = (n.getAttribute('class') ?? '').split(/\s+/);
    if (classes.includes('admonition') && classes.includes('important')) return true;
  }
  return false;
}
