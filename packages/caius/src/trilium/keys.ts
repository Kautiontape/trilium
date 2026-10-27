// Source keys: how the planning writes recognise "the same thing" twice.
// A task's keys are its Jira keys and source URLs; a task with neither is
// identified by a short hash of its normalised text. `add` skips a candidate
// whose keys overlap a live task's, or a key dismissed on the note.

import { createHash } from 'node:crypto';

export const JIRA_BASE = 'https://zeroedin.atlassian.net/browse/';

/** Project prefixes recognised as Jira keys when they appear bare in task text (`--source` accepts any prefix). */
export const JIRA_PROJECTS = ['ZAP', 'ZIS', 'SUR', 'CM'];

const BARE_KEY = new RegExp(`\\b(?:${JIRA_PROJECTS.join('|')})-\\d+\\b`, 'g');
const BROWSE = /\/browse\/([A-Z][A-Z0-9]+-\d+)(?![\w-])/;
const LINK = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** `[label](url)` links out of a markdown task line: the text with links reduced to labels, and the urls. */
export function markdownLinks(text: string): { text: string; urls: string[] } {
  const urls: string[] = [];
  const plain = text.replace(LINK, (_m, label: string, url: string) => {
    urls.push(url);
    return label;
  });
  return { text: plain, urls };
}

export function normalizeUrl(url: string): string {
  return url.trim().replace(/#.*$/, '').replace(/\/+$/, '');
}

export function textHash(text: string): string {
  const norm = markdownLinks(text)
    .text.replace(/(?:\s+(?:~\d+h\d+m|~\d+h|~\d+m|!{1,3}))+\s*$/, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
  return createHash('sha1').update(norm).digest('hex').slice(0, 12);
}

/** Keys for a task's plain text and the hrefs of its links. The first is the one `dismiss` stores. */
export function taskKeys(text: string, hrefs: string[] = []): string[] {
  const urls = hrefs.filter((h) => /^https?:\/\//i.test(h)).map(normalizeUrl);
  const jira = new Set<string>();
  for (const m of text.matchAll(BARE_KEY)) jira.add(m[0]);
  for (const u of urls) {
    const k = BROWSE.exec(u)?.[1];
    if (k) jira.add(k);
  }
  const keys = [...jira, ...urls.filter((u) => !jira.has(u))];
  return keys.length ? [...new Set(keys)] : [textHash(text)];
}

/** `--source`: a Jira key, a Jira URL or any http(s) URL. */
export function parseSource(source: string): { keys: string[]; url: string; label: string; jira: string | null } | null {
  const s = source.trim();
  if (/^[A-Z][A-Z0-9]+-\d+$/.test(s)) return { keys: taskKeys('', [`${JIRA_BASE}${s}`]), url: `${JIRA_BASE}${s}`, label: s, jira: s };
  if (!/^https?:\/\/\S+$/i.test(s)) return null;
  const jira = BROWSE.exec(s)?.[1] ?? null;
  let label = jira;
  if (!label) {
    try {
      label = new URL(s).hostname.replace(/^www\./, '');
    } catch {
      return null;
    }
  }
  return { keys: taskKeys('', [s]), url: s, label, jira };
}

/** A well-formed estimate: `30m`, `2h`, `1h30m`, with or without the leading `~`. */
export function parseEstimate(est: string): string | null {
  const m = /^~?(\d+h\d+m|\d+h|\d+m)$/.exec(est.trim());
  return m ? m[1]! : null;
}
