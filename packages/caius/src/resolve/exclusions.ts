// Indexing exclusions (§7, roles.excluded). A file is skipped if its
// vault-relative path matches any excluded glob.

import { matchGlob } from './glob.js';
import { type Config } from './config.js';

export function isExcluded(file: string, config: Config): boolean {
  return config.excluded.some((pattern) => matchGlob(pattern, file));
}
