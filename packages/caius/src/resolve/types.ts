// A resolved axis value carrying provenance (§4). The rule that fired and the
// source that justified it are mandatory — explainability is not optional.
export interface Derived {
  value: string | null;
  rule: string;
  source: string;
}

/** Presentation grains (the GUI's vocabulary). Must match the GUI's lib/grains.ts. */
export const GRAINS = ['someday', 'month', 'week', 'day'] as const;
export type Grain = (typeof GRAINS)[number];

/** Period bucket relative to *now* at a grain's granularity. */
export const BUCKETS = ['past', 'this', 'next', 'future'] as const;
export type Bucket = (typeof BUCKETS)[number];
