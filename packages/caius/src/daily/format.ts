// Durations as the planning text writes them.

/** Minutes as a `~est` token's value: `30m`, `1h`, `1h30m`. */
export function formatEstimate(minutes: number): string {
  const [hours, rest] = [Math.floor(minutes / 60), Math.round(minutes % 60)];
  return hours ? `${hours}h${rest ? `${rest}m` : ''}` : `${rest}m`;
}

/** Minutes as `3 h 20 m`, `1 h` or `45 m`. */
export function formatHours(minutes: number): string {
  const [hours, rest] = [Math.floor(minutes / 60), Math.round(minutes % 60)];
  return hours ? `${hours} h${rest ? ` ${rest} m` : ''}` : `${rest} m`;
}
