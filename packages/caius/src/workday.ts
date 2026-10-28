// Monday to Friday are workdays.

/** The first workday after `date`, at local midnight: Friday → Monday, Saturday → Monday. */
export function nextWorkday(date: Date): Date {
  return step(date, 1);
}

/** The last workday before `date`, at local midnight: Monday → Friday, Sunday → Friday. */
export function lastWorkday(date: Date): Date {
  return step(date, -1);
}

function step(date: Date, direction: 1 | -1): Date {
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  do {
    day.setDate(day.getDate() + direction);
  } while (day.getDay() === 0 || day.getDay() === 6);
  return day;
}

/** Minutes after midnight at which the day rolls over when the standing note doesn't say: 04:00. */
export const DEFAULT_ROLLOVER = 4 * 60;

/** The day `at` belongs to as `YYYY-MM-DD`: before `rollover` (minutes after midnight), the previous calendar date. */
export function workdayKey(at: Date, rollover: number): string {
  const day = workdayNow(at, rollover);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
}

/**
 * `at` as its workday sees it: before `rollover`, the same clock time on the previous calendar
 * day, so its date is the workday and its time still reads 01:30. Read the time of day of such a
 * moment with `workdayClock`, not `getHours`.
 */
export function workdayNow(at: Date, rollover: number): Date {
  return at.getHours() * 60 + at.getMinutes() < rollover
    ? new Date(at.getFullYear(), at.getMonth(), at.getDate() - 1, at.getHours(), at.getMinutes(), at.getSeconds(), at.getMilliseconds())
    : at;
}

/** Minutes into the workday of a moment `workdayNow` made: past `24 * 60` in the small hours. */
export function workdayMinutes(day: Date, rollover: number): number {
  const minutes = day.getHours() * 60 + day.getMinutes();
  return minutes < rollover ? minutes + 24 * 60 : minutes;
}

/** `HH:MM` of a moment `workdayNow` made, from `00:00` to `27:59`: 01:30 after midnight reads `25:30`. */
export function workdayClock(day: Date, rollover: number): string {
  const minutes = workdayMinutes(day, rollover);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
