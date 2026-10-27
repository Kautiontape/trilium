// Horizon axis (§5, D8). Date-relative: periodic notes classify by the date in
// their filename vs *now*; static rules map a folder straight to a level.
// First matching rule wins. Also emits the structured { grain, bucket } the
// ritual GUI consumes (the `horizon` string alone is lossy — see spec §3).

import { matchGlob } from './glob.js';
import { type Config, isPeriodicRule } from './config.js';
import {
  classifyPeriod,
  granularityForFormat,
  periodBucket,
  type PeriodGranularity,
  type PeriodRelation,
} from './period.js';
import { type Derived, type Grain, type Bucket } from './types.js';

/** A horizon resolution + its structured grain/bucket (non-breaking superset of Derived). */
export interface HorizonResult extends Derived {
  grain: Grain | null;
  bucket: Bucket | null;
}

const RELATION_WORD: Record<PeriodRelation, string> = {
  current: 'current',
  future: 'future',
  past: 'past',
};

const GRAIN_FOR: Record<PeriodGranularity, Grain> = {
  day: 'day',
  isoweek: 'week',
  month: 'month',
};

/** Friendly rule label, e.g. "02 - Periodic/Daily/**" → "Daily". */
function periodicLabel(match: string): string {
  const m = match.match(/Periodic\/([^/]+)/);
  return m ? m[1]! : match;
}

function leafOf(file: string): string {
  const base = file.slice(file.lastIndexOf('/') + 1);
  return base.replace(/\.md$/i, '');
}

/** A static horizon string maps to a grain only when it is the someday master list. */
function staticGrain(horizon: string): Grain | null {
  return horizon === 'someday' ? 'someday' : null;
}

/** Resolve the horizon for a file at a given moment. Always returns a value. */
export function resolveHorizon(file: string, now: Date, config: Config): HorizonResult {
  for (const rule of config.horizon_mapping) {
    if (!matchGlob(rule.match, file)) continue;

    if (isPeriodicRule(rule)) {
      const granularity = granularityForFormat(rule.date);
      if (!granularity) continue;
      const leaf = leafOf(file);
      const relation = classifyPeriod(granularity, leaf, now);
      if (!relation) continue; // glob matched but no parseable period → fall through
      const label = periodicLabel(rule.match);
      const unit = granularity === 'isoweek' ? 'week' : granularity;
      return {
        value: rule.by_date[relation],
        rule: `${label} periodic rule (${RELATION_WORD[relation]} → ${rule.by_date[relation]})`,
        source: `${RELATION_WORD[relation]} ${unit} ${leaf} vs now`,
        grain: GRAIN_FOR[granularity],
        bucket: periodBucket(granularity, leaf, now),
      };
    }

    return {
      value: rule.horizon,
      rule: `static rule ${rule.match}`,
      source: `path matches ${rule.match}`,
      grain: staticGrain(rule.horizon),
      bucket: null,
    };
  }

  return {
    value: config.horizon_default,
    rule: 'default',
    source: 'no horizon rule matched',
    grain: staticGrain(config.horizon_default),
    bucket: null,
  };
}
