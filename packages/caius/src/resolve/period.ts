// Period classification for the date-relative horizon (§5, D8).
// A periodic note's leaf filename carries a date; we recover the period and
// compare it to *now* at the rule's granularity, yielding past/current/future.

import type { Bucket } from './types.js';

export type PeriodGranularity = 'day' | 'isoweek' | 'month';
export type PeriodRelation = 'past' | 'current' | 'future';

/** Map a config `date:` format token to a comparison granularity. */
export function granularityForFormat(format: string): PeriodGranularity | null {
  if (format.includes('W')) return 'isoweek'; // GGGG-[W]WW
  if (format.includes('D')) return 'day'; // YYYY-MM-DD
  if (format.includes('M')) return 'month'; // YYYY-MM
  return null;
}

/** ISO 8601 week-year + week number for a local date. */
function isoWeekKey(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7; // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // shift to the Thursday of this week
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return d.getUTCFullYear() * 100 + week;
}

/** Comparable integer key for a leaf filename at a given granularity, or null. */
function leafKey(granularity: PeriodGranularity, leaf: string): number | null {
  switch (granularity) {
    case 'day': {
      const m = leaf.match(/(\d{4})-(\d{2})-(\d{2})/);
      if (!m) return null;
      return Number(m[1]) * 10_000 + Number(m[2]) * 100 + Number(m[3]);
    }
    case 'month': {
      const m = leaf.match(/(\d{4})-(\d{2})/);
      if (!m) return null;
      return Number(m[1]) * 100 + Number(m[2]);
    }
    case 'isoweek': {
      const m = leaf.match(/(\d{4})-W(\d{2})/i);
      if (!m) return null;
      return Number(m[1]) * 100 + Number(m[2]);
    }
  }
}

function nowKey(granularity: PeriodGranularity, now: Date): number {
  switch (granularity) {
    case 'day':
      return now.getFullYear() * 10_000 + (now.getMonth() + 1) * 100 + now.getDate();
    case 'month':
      return now.getFullYear() * 100 + (now.getMonth() + 1);
    case 'isoweek':
      return isoWeekKey(now);
  }
}

/**
 * Classify a periodic note's leaf filename against `now`.
 * Returns null when the leaf carries no parseable date for this granularity.
 */
export function classifyPeriod(
  granularity: PeriodGranularity,
  leaf: string,
  now: Date,
): PeriodRelation | null {
  const key = leafKey(granularity, leaf);
  if (key === null) return null;
  const ref = nowKey(granularity, now);
  if (key < ref) return 'past';
  if (key > ref) return 'future';
  return 'current';
}

/** Comparable key for the period immediately after `now` (handles year/week/month rollover). */
function nextKey(granularity: PeriodGranularity, now: Date): number {
  switch (granularity) {
    case 'day': {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      return nowKey('day', d);
    }
    case 'isoweek': {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7);
      return nowKey('isoweek', d);
    }
    case 'month': {
      const d = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      return nowKey('month', d);
    }
  }
}

/**
 * 4-way refinement of {@link classifyPeriod}: distinguishes the *next* bucket
 * (tomorrow / next ISO week / next month) from anything further out. Returns
 * null when the leaf carries no parseable date for this granularity.
 */
export function periodBucket(
  granularity: PeriodGranularity,
  leaf: string,
  now: Date,
): Bucket | null {
  const key = leafKey(granularity, leaf);
  if (key === null) return null;
  const ref = nowKey(granularity, now);
  if (key < ref) return 'past';
  if (key === ref) return 'this';
  return key === nextKey(granularity, now) ? 'next' : 'future';
}
