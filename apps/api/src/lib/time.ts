/**
 * Zeitzonen-Hilfen ohne zusätzliche Abhängigkeiten. Ein „Tag“ ist immer ein
 * Kalendertag in der Zeitzone der Anlage, nicht in UTC.
 */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const isIsoDate = (value: string): boolean =>
  DATE_PATTERN.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts: Record<string, number> = {};
  for (const part of partsFormatter(timeZone).formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
    second: parts.second!,
  };
}

/** Versatz der Zeitzone gegenüber UTC in Millisekunden zum angegebenen Zeitpunkt */
function offsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Lokale Uhrzeit in der Zeitzone als UTC-Zeitpunkt */
export function zonedToUtc(p: ZonedParts, timeZone: string): Date {
  const guess = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Zweimal korrigieren, damit Sommerzeitwechsel am selben Tag korrekt behandelt werden
  const first = guess - offsetMs(new Date(guess), timeZone);
  return new Date(guess - offsetMs(new Date(first), timeZone));
}

/** Lokale Mitternacht des Kalendertags als UTC-Zeitpunkt */
function zonedMidnight(isoDate: string, timeZone: string): Date {
  const [year, month, day] = isoDate.split("-").map(Number) as [number, number, number];
  return zonedToUtc({ year, month, day, hour: 0, minute: 0, second: 0 }, timeZone);
}

/** Halboffenes Intervall [start, end) eines Kalendertags */
export function dayRange(isoDate: string, timeZone: string): { start: Date; end: Date } {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return { start: zonedMidnight(isoDate, timeZone), end: zonedMidnight(next, timeZone) };
}

export function isoDateInZone(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Tag im Jahr (1–366) eines Kalenderdatums */
export function dayOfYear(isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86_400_000) + 1;
}
