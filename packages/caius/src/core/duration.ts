// Minutes as the hours-and-minutes text people read. Free of other imports so the client can
// load this module alone.

/** `220` → `3 h 40 m`, `45` → `45 m`, `240` → `4 h`, `0` → `0 m`. */
export function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} m`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} m`;
}

/** `180, 240` → `3–4 h`; ends that aren't whole hours read in full, as `2 h 30 m–4 h`. */
export function formatMinutesRange(min: number, max: number): string {
  if (min % 60 === 0 && max % 60 === 0) return `${min / 60}–${max / 60} h`;
  return `${formatMinutes(min)}–${formatMinutes(max)}`;
}
