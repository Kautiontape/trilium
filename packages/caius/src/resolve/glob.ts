// Minimal vault-relative glob matcher (§7 semantics):
//   `*`     matches within one path segment (never crosses `/`)
//   `**` + `/`  matches zero or more whole segments
//   trailing `**`   matches anything (used as a trailing `dir/**`)
// Case-sensitive, anchored end-to-end. All other characters are literal.
function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; ) {
    if (pattern[i] === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          re += '(?:[^/]+/)*'; // **/  → zero or more segments
          i += 3;
        } else {
          re += '.*'; // **  → anything
          i += 2;
        }
      } else {
        re += '[^/]*'; // *  → within one segment
        i += 1;
      }
    } else {
      re += pattern[i]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp('^' + re + '$');
}

const cache = new Map<string, RegExp>();

export function matchGlob(pattern: string, path: string): boolean {
  let re = cache.get(pattern);
  if (!re) {
    re = globToRegExp(pattern);
    cache.set(pattern, re);
  }
  return re.test(path);
}

/** Resolve a capture token ({seg1}/{filename}/{folder}) against a matched path. */
export function capture(token: string, pattern: string, path: string): string {
  const segs = path.split('/');
  switch (token) {
    case '{filename}':
      return (segs[segs.length - 1] ?? '').replace(/\.md$/, '');
    case '{folder}':
      return segs[segs.length - 2] ?? '';
    case '{seg1}': {
      const star = pattern.indexOf('*');
      const prefix = star >= 0 ? pattern.slice(0, star) : '';
      const remainder = path.startsWith(prefix) ? path.slice(prefix.length) : path;
      return remainder.split('/')[0] ?? '';
    }
    default:
      return '';
  }
}
