import type { Freshness } from "./types.js";

/**
 * Bewertet, ob ein Messwert noch als aktuell gelten darf. Ein fehlgeschlagener
 * Abruf darf nie dazu führen, dass ein alter Wert als „live“ erscheint.
 */
export function assessFreshness(
  measuredAt: string | Date | null,
  now: Date,
  staleAfterSeconds: number,
): Freshness {
  if (measuredAt === null) return { status: "unavailable", ageSeconds: null };

  const measuredMs = typeof measuredAt === "string" ? Date.parse(measuredAt) : measuredAt.getTime();
  const ageSeconds = Math.max(0, Math.round((now.getTime() - measuredMs) / 1000));
  return { status: ageSeconds <= staleAfterSeconds ? "live" : "stale", ageSeconds };
}
