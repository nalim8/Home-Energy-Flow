export { formatEnergy, formatPower, formatRatio } from "@hef/energy-domain";

export function formatTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("de-DE", { timeZone, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

const DATE_STYLES: Record<"long" | "short" | "weekday" | "dayMonth", Intl.DateTimeFormatOptions> = {
  long: { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" },
  short: { weekday: "short", day: "2-digit", month: "2-digit", timeZone: "UTC" },
  weekday: { weekday: "short", timeZone: "UTC" },
  dayMonth: { day: "2-digit", month: "2-digit", timeZone: "UTC" },
};

/** Monat (YYYY-MM) als „Okt. 26“ bzw. „Oktober 2026“ */
export function formatMonth(month: string, style: "short" | "long"): string {
  const options: Intl.DateTimeFormatOptions =
    style === "short" ? { month: "short", year: "2-digit", timeZone: "UTC" } : { month: "long", year: "numeric", timeZone: "UTC" };
  return new Intl.DateTimeFormat("de-DE", options).format(new Date(`${month}-15T12:00:00Z`));
}

export function formatDate(isoDate: string, style: keyof typeof DATE_STYLES = "long"): string {
  const date = new Date(`${isoDate}T12:00:00Z`);
  const options = DATE_STYLES[style];
  return new Intl.DateTimeFormat("de-DE", options).format(date);
}

/** „vor 12 s“, „vor 4 min“, „vor 2 h“ */
export function formatAge(seconds: number): string {
  if (seconds < 60) return `vor ${seconds} s`;
  if (seconds < 3600) return `vor ${Math.round(seconds / 60)} min`;
  if (seconds < 86_400) return `vor ${Math.round(seconds / 3600)} h`;
  return `vor ${Math.round(seconds / 86_400)} Tagen`;
}

export function todayIn(timeZone: string): string {
  // en-CA liefert YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
}

export function shiftDate(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
