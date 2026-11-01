import { computeBalance, computeFlows } from "@hef/energy-domain";
import { describe, expect, it } from "vitest";
import { DemoEnergyProvider, DemoSimulator, pvPower } from "../src/energy/demo-provider.js";
import { energySnapshotSchema } from "../src/energy/schema.js";

const TZ = "Europe/Berlin";

describe("DemoSimulator", () => {
  const provider = new DemoEnergyProvider(TZ);
  const week = provider.backfill(new Date("2026-06-15T00:00:00Z"), new Date("2026-06-22T00:00:00Z"));

  it("erzeugt gültige Messwerte im Minutenraster", () => {
    expect(week).toHaveLength(7 * 24 * 60);
    for (const s of week) expect(energySnapshotSchema.safeParse(s).success).toBe(true);
  });

  it("hält die Leistungsbilanz an jedem Zeitpunkt ein", () => {
    // Abweichung nur durch die Leerlaufschwelle am Netzanschluss
    for (const s of week) expect(Math.abs(computeFlows(s).unbalancedW)).toBeLessThan(20);
  });

  it("liefert nachts keine PV-Leistung und mittags im Sommer deutlich", () => {
    expect(pvPower(new Date("2026-06-21T00:30:00Z"), 9900)).toBe(0);
    expect(pvPower(new Date("2026-06-21T11:20:00Z"), 9900)).toBeGreaterThan(500);
  });

  it("produziert im Sommer mehr als im Winter", () => {
    // Über einen Monat gemittelt, damit einzelne Wolkentage nicht entscheiden
    const monthWh = (startUtc: number) => {
      let wh = 0;
      for (let t = startUtc; t < startUtc + 30 * 86_400_000; t += 600_000) wh += pvPower(new Date(t), 9900) / 6;
      return wh;
    };
    expect(monthWh(Date.UTC(2026, 5, 1))).toBeGreaterThan(2 * monthWh(Date.UTC(2026, 11, 1)));
  });

  it("lädt und entlädt den Speicher innerhalb seiner Grenzen", () => {
    const socs = week.map((s) => s.batterySocPercent);
    expect(Math.min(...socs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...socs)).toBeLessThanOrEqual(100);
    expect(week.some((s) => s.batteryPowerW > 0)).toBe(true);
    expect(week.some((s) => s.batteryPowerW < 0)).toBe(true);
  });

  it("ergibt eine plausible Wochenbilanz", () => {
    const balance = computeBalance(week);
    expect(balance.pvWh / 7).toBeGreaterThan(10_000);
    expect(balance.householdWh / 7).toBeGreaterThan(5_000);
    expect(balance.autarkyRate).toBeGreaterThan(0.5);
  });

  it("ist bei gleicher Zeitfolge deterministisch", () => {
    const run = () => {
      const sim = new DemoSimulator(TZ);
      return [0, 1, 2].map((m) => sim.sample(new Date(Date.UTC(2026, 5, 21, 12, m))));
    };
    expect(run()).toEqual(run());
  });
});
