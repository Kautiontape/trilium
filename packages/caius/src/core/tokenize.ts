import type { Token } from './types.js';

/**
 * A trailing-token matcher. Each `re` is right-anchored and requires the token
 * to be at start-of-zone or preceded by whitespace (§3.3 "whitespace-delimited"),
 * so sigils glued to a word (`mom!`) or mid-line stay prose. `m.index` points at
 * that boundary, so `rest.slice(0, m.index)` removes the whitespace + token.
 */
interface Matcher {
  re: RegExp;
  make: (m: RegExpExecArray) => Token;
}

// Ordered most-specific first (matters once bracketed `:[[ ]]` vs `from:`/`moved:`
// land — a more-specific prefix must win before a looser one).
const MATCHERS: Matcher[] = [
  {
    re: /(?:^|\s)(!{1,3})$/,
    make: (m) => ({ kind: 'importance', raw: m[1]!, tier: m[1]!.length as 1 | 2 | 3 }),
  },
  {
    // ~2h | ~30m | ~1h30m  (fractional like ~1.5h intentionally unsupported)
    re: /(?:^|\s)(~(\d+)h(\d+)m|~(\d+)h|~(\d+)m)$/,
    make: (m) => {
      const minutes = m[2]
        ? Number(m[2]) * 60 + Number(m[3])
        : m[4]
          ? Number(m[4]) * 60
          : Number(m[5]);
      return { kind: 'estimate', raw: m[1]!, minutes };
    },
  },
  {
    re: /(?:^|\s)\*(\d{4}-\d{2}-\d{2})$/,
    make: (m) => ({ kind: 'due', raw: `*${m[1]!}`, date: m[1]! }),
  },
  {
    re: /(?:^|\s)done:(\d{4}-\d{2}-\d{2})$/,
    make: (m) => ({ kind: 'done', raw: `done:${m[1]!}`, date: m[1]! }),
  },
  // Bracketed wikilink tokens, most-specific prefix first so `moved:`/`from:`
  // win before the bare `:[[ ]]` project override.
  {
    re: /(?:^|\s)moved:\[\[([^\]#]+)#\^([A-Za-z0-9_-]+)\]\]$/,
    make: (m) => ({ kind: 'moved', raw: `moved:[[${m[1]!}#^${m[2]!}]]`, note: m[1]!, blockId: m[2]! }),
  },
  {
    re: /(?:^|\s)from:\[\[([^\]#]+)(?:#\^([A-Za-z0-9_-]+))?\]\]$/,
    make: (m) => ({
      kind: 'from',
      raw: m[2] ? `from:[[${m[1]!}#^${m[2]}]]` : `from:[[${m[1]!}]]`,
      note: m[1]!,
      blockId: m[2] ?? null,
    }),
  },
  {
    re: /(?:^|\s):\[\[([^\]]+)\]\]$/,
    make: (m) => ({ kind: 'project', raw: `:[[${m[1]!}]]`, project: m[1]! }),
  },
  {
    re: /(?:^|\s)&([A-Za-z]+)$/,
    make: (m) => ({ kind: 'recurrence', raw: `&${m[1]!}`, rule: m[1]! }),
  },
];

/**
 * Right-to-left trailing-token scan. Repeatedly strips a recognized token from
 * the end; the first field that matches nothing ends the zone — everything left
 * of it is freeform TEXT. Returns tokens in source (left-to-right) order.
 */
export function scanTokens(input: string): { text: string; tokens: Token[] } {
  let rest = input;
  const tokens: Token[] = [];

  for (;;) {
    rest = rest.replace(/\s+$/, ''); // drop the gap left by the previous strip
    const before = rest;
    for (const { re, make } of MATCHERS) {
      const m = re.exec(rest);
      if (m) {
        tokens.unshift(make(m));
        rest = rest.slice(0, m.index);
        break;
      }
    }
    if (rest === before) break;
  }

  return { text: rest.trim(), tokens };
}
