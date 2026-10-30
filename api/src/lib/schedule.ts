// Local daily/weekly schedules for Gond Agent Runners. Times stay on the chosen clock across DST:
// a repeated hour runs once, a skipped hour moves to the first valid minute after it.

export type Frequency = "daily" | "weekly";

export interface Schedule {
  frequency: Frequency;
  /** Monday = 0 … Sunday = 6. Required for weekly. */
  weekdays: number[];
  /** Minutes after local midnight. */
  minute: number;
  timezone: string;
}

const DAY = 86_400_000;
const WEEKDAYS = [1, 2, 4, 8, 16, 32, 64];

export function weekdayMask(days: number[]): number {
  return days.reduce((mask, day) => mask | (WEEKDAYS[day] ?? 0), 0);
}

export function weekdaysFromMask(mask: number): number[] {
  return WEEKDAYS.flatMap((bit, day) => (mask & bit ? [day] : []));
}

/** True when the runtime can format dates in this IANA zone. */
export function validTimezone(zone: string): boolean {
  if (!zone || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(0);
    return true;
  } catch {
    return false;
  }
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  weekday: number;
  minute: number;
}

const partsOf = (ms: number, zone: string): LocalParts => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  }).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday"));
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    weekday,
    minute: Number(get("hour")) * 60 + Number(get("minute")),
  };
};

const utcGuess = (year: number, month: number, day: number, minute: number) => Date.UTC(year, month - 1, day, Math.floor(minute / 60), minute % 60);

/**
 * The UTC instant of a local civil time. A repeated local hour resolves to its first occurrence;
 * a missing one resolves to the first valid minute at or after it.
 */
function instant(year: number, month: number, day: number, minute: number, zone: string): number {
  let guess = utcGuess(year, month, day, minute);
  for (let i = 0; i < 4; i++) {
    const local = partsOf(guess, zone);
    const localUtc = utcGuess(local.year, local.month, local.day, local.minute);
    const wanted = utcGuess(year, month, day, minute);
    const next = guess + (wanted - localUtc);
    if (next === guess) break;
    guess = next;
  }
  const local = partsOf(guess, zone);
  if (local.year === year && local.month === month && local.day === day && local.minute === minute) return guess;
  // The requested local minute does not exist (a spring-forward gap). Search forward from the same civil date.
  const start = Date.UTC(year, month - 1, day, 0, 0) - 14 * 3_600_000;
  for (let step = 0; step <= 42 * 60; step++) {
    const candidate = start + step * 60_000;
    const at = partsOf(candidate, zone);
    if (at.year === year && at.month === month && at.day === day && at.minute >= minute) return candidate;
  }
  return guess;
}

const nextDate = (year: number, month: number, day: number) => {
  const date = new Date(Date.UTC(year, month - 1, day + 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
};

/** The next scheduled instant strictly after `after`. */
export function nextRunAt(schedule: Schedule, after: number): number {
  const start = partsOf(after, schedule.timezone);
  let cursor = { year: start.year, month: start.month, day: start.day };
  for (let i = 0; i < 14; i++) {
    const at = instant(cursor.year, cursor.month, cursor.day, schedule.minute, schedule.timezone);
    const local = partsOf(at, schedule.timezone);
    const wanted = schedule.frequency === "daily" || schedule.weekdays.includes(local.weekday);
    if (wanted && at > after) return at;
    cursor = nextDate(cursor.year, cursor.month, cursor.day);
  }
  return after + 7 * DAY;
}

const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** A short schedule line, such as "Every weekday at 9:00 AM". */
export function describeSchedule(schedule: Schedule): string {
  const hour = Math.floor(schedule.minute / 60);
  const suffix = hour < 12 ? "AM" : "PM";
  const shown = hour % 12 || 12;
  const time = `${shown}:${String(schedule.minute % 60).padStart(2, "0")} ${suffix}`;
  if (schedule.frequency === "daily") return `Every day at ${time}`;
  const days = [...schedule.weekdays].sort((a, b) => a - b);
  const names =
    days.length === 5 && days.every((day, i) => day === i)
      ? "weekday"
      : days.length === 7
        ? "day"
        : days.map((day) => WEEKDAY_NAMES[day]).join(", ");
  return `Every ${names} at ${time}`;
}

/** "Monday, October 12 at 9:00 AM" in the schedule's zone. */
export function formatWhen(ms: number, zone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms));
}
