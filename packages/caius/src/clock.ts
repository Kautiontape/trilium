// The one place Caius reads the current time.

type Env = Record<string, string | undefined>;

const LOCAL_ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * The current moment. With `TRILIUM_ENV=dev` and `CAIUS_NOW` set to a local ISO time
 * (`2026-11-06T17:30`), that time; otherwise `real()`, so a `CAIUS_NOW` left set in production
 * changes nothing. A `CAIUS_NOW` that is not a local ISO time is ignored.
 */
export function now(env: Env = processEnv(), real: () => Date = () => new Date()): Date {
  return clockOverride(env) ?? real();
}

/** The dev-only override `now()` applies, or `null` when it applies none. */
export function clockOverride(env: Env = processEnv()): Date | null {
  const override = env.TRILIUM_ENV === 'dev' ? LOCAL_ISO.exec(env.CAIUS_NOW ?? '') : null;
  if (!override) return null;
  const [year, month, day, hour, minute, second] = override.slice(1).map((part) => Number(part || 0)) as [number, number, number, number, number, number];
  const at = new Date(year, month - 1, day, hour, minute, second);
  const real = at.getFullYear() === year && at.getMonth() === month - 1 && at.getDate() === day && at.getHours() === hour && at.getMinutes() === minute;
  return real ? at : null;
}

function processEnv(): Env {
  return typeof process === 'undefined' ? {} : process.env;
}
