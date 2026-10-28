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
