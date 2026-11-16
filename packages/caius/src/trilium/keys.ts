// Source keys: how the planning writes recognise "the same thing" twice.
// A task's keys are its Jira keys and source URLs; a task with neither is
// identified by a short hash of its normalised text. `add` skips a candidate
// whose keys overlap a live task's, or a key dismissed on the note.

import { createHash } from 'node:crypto';

/** Which Jira projects count as keys when bare in task text, and where `--source` keys link to. */
export interface KeyConfig {
  projects: string[];
  /** The site's browse URL prefix, such as `https://example.atlassian.net/browse/`; null links no key. */
  browseBase: string | null;
}

let config: KeyConfig = { projects: [], browseBase: null };

/** Replaces the key config; the caller sets it before deriving keys. */
export function setKeyConfig(next: KeyConfig): void {
  config = { projects: [...next.projects], browseBase: next.browseBase };
}

export function keyConfig(): KeyConfig {
  return config;
}

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
export function taskKeys(text: string, hrefs: string[] = [], projects: string[] = config.projects): string[] {
  const urls = hrefs.filter((h) => /^https?:\/\//i.test(h)).map(normalizeUrl);
  const jira = new Set<string>();
  const bare = bareKeyPattern(projects);
  if (bare) for (const m of text.matchAll(bare)) jira.add(m[0]);
  for (const u of urls) {
    const k = BROWSE.exec(u)?.[1];
    if (k) jira.add(k);
  }
  const keys = [...jira, ...urls.filter((u) => !jira.has(u))];
  return keys.length ? [...new Set(keys)] : [textHash(text)];
}

/** `--source`: a Jira key, a Jira URL or any http(s) URL. A key links only when there is a browse base. */
export function parseSource(
  source: string,
  browseBase: string | null = config.browseBase,
): { keys: string[]; url: string | null; label: string; jira: string | null } | null {
  const s = source.trim();
  if (/^[A-Z][A-Z0-9]+-\d+$/.test(s)) {
    if (browseBase === null) return { keys: [s], url: null, label: s, jira: s };
    return { keys: taskKeys('', [`${browseBase}${s}`]), url: `${browseBase}${s}`, label: s, jira: s };
  }
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
  return { keys: taskKeys('', [s], []), url: s, label, jira };
}

/** A bare-key pattern for `projects`; null for an empty list, which would match `-8` in `UTF-8`. */
function bareKeyPattern(projects: string[]): RegExp | null {
  const names = projects.filter((p) => /^[A-Z][A-Z0-9]+$/.test(p));
  return names.length ? new RegExp(`\\b(?:${names.join('|')})-\\d+\\b`, 'g') : null;
}

/** A well-formed estimate: `30m`, `2h`, `1h30m`, with or without the leading `~`. */
export function parseEstimate(est: string): string | null {
  const m = /^~?(\d+h\d+m|\d+h|\d+m)$/.exec(est.trim());
  return m ? m[1]! : null;
}
