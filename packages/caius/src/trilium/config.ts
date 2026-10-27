// Resolution config for a Trilium Journal loaded by ./journal.ts. Same horizon
// rules as the Obsidian vault's periodic notes, over the virtual paths.

import { DEFAULT_CONFIG, type Config } from '../resolve/index.js';

export const TRILIUM_CONFIG: Config = {
  ...DEFAULT_CONFIG,
  horizon_mapping: [
    {
      match: 'Journal/Daily/**/*.md',
      date: 'YYYY-MM-DD',
      by_date: { current: 'today', future: 'week', past: 'overdue' },
    },
    {
      match: 'Journal/Weekly/**/*.md',
      date: 'GGGG-[W]WW',
      by_date: { current: 'week', future: 'orbit', past: 'overdue' },
    },
    {
      match: 'Journal/Monthly/**/*.md',
      date: 'YYYY-MM',
      by_date: { current: 'orbit', future: 'planning_ahead', past: 'overdue' },
    },
  ],
  project_mapping: [],
  excluded: [],
};
