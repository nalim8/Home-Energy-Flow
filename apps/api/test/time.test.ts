import { describe, expect, it } from "vitest";
import { addDays, dayOfYear, dayRange, isIsoDate, isoDateInZone } from "../src/lib/time.js";

const TZ = "Europe/Berlin";

describe("time", () => {
  it("berechnet Kalendertage in der Anlagen-Zeitzone", () => {
    expect(dayRange("2026-06-21", TZ)).toEqual({
      start: new Date("2026-06-20T22:00:00Z"),
      end: new Date("2026-06-21T22:00:00Z"),
    });
  });

  it("behandelt die Zeitumstellung (23- und 25-Stunden-Tage)", () => {
    const spring = dayRange("2026-03-29", TZ);
    expect((spring.end.getTime() - spring.start.getTime()) / 3_600_000).toBe(23);
    const autumn = dayRange("2026-10-25", TZ);
    expect((autumn.end.getTime() - autumn.start.getTime()) / 3_600_000).toBe(25);
  });

  it("ordnet Zeitpunkte dem lokalen Datum zu", () => {
    expect(isoDateInZone(new Date("2026-06-20T22:30:00Z"), TZ)).toBe("2026-06-21");
  });

  it("validiert und verschiebt Daten", () => {
    expect(isIsoDate("2026-06-21")).toBe(true);
    expect(isIsoDate("21.06.2026")).toBe(false);
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(dayOfYear("2026-12-31")).toBe(365);
  });
});
