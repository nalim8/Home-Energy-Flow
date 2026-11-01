import { describe, expect, it } from "vitest";
import {
  assessFreshness,
  computeBalance,
  computeFlows,
  formatEnergy,
  formatPower,
  signedGridPower,
  splitGridPower,
  sumBalances,
  type EnergySnapshot,
} from "../src/index.js";

function snapshot(overrides: Partial<EnergySnapshot> = {}): EnergySnapshot {
  return {
    timestamp: "2026-06-21T12:00:00.000Z",
    pvPowerW: 0,
    householdPowerW: 0,
    batteryPowerW: 0,
    batterySocPercent: 50,
    gridPowerW: 0,
    gridDirection: "idle",
    source: "demo",
    ...overrides,
  };
}

describe("units", () => {
  it("formatiert Leistung in W und Energie in kWh", () => {
    expect(formatPower(3200)).toBe("3.200 W");
    expect(formatPower(187.4)).toBe("187 W");
    expect(formatEnergy(12_449)).toBe("12,4 kWh");
  });
});

describe("grid", () => {
  it("unterscheidet Bezug, Einspeisung und Leerlauf", () => {
    expect(splitGridPower(400)).toEqual({ gridPowerW: 400, gridDirection: "import" });
    expect(splitGridPower(-400)).toEqual({ gridPowerW: 400, gridDirection: "export" });
    expect(splitGridPower(5)).toEqual({ gridPowerW: 0, gridDirection: "idle" });
  });

  it("liefert vorzeichenbehaftete Netzleistung", () => {
    expect(signedGridPower({ gridPowerW: 400, gridDirection: "export" })).toBe(-400);
    expect(signedGridPower({ gridPowerW: 400, gridDirection: "import" })).toBe(400);
    expect(signedGridPower({ gridPowerW: 400, gridDirection: "idle" })).toBe(0);
  });
});

describe("computeFlows", () => {
  it("verteilt PV-Überschuss auf Haus, Speicher und Netz", () => {
    const flows = computeFlows(
      snapshot({ pvPowerW: 3200, householdPowerW: 1100, batteryPowerW: 1700, gridPowerW: 400, gridDirection: "export" }),
    );
    expect(flows).toMatchObject({ pvToHouse: 1100, pvToBattery: 1700, pvToGrid: 400, gridToHouse: 0, unbalancedW: 0 });
  });

  it("versorgt das Haus nachts aus Speicher und Netz", () => {
    const flows = computeFlows(
      snapshot({ householdPowerW: 2500, batteryPowerW: -2000, gridPowerW: 500, gridDirection: "import" }),
    );
    expect(flows).toMatchObject({ pvToHouse: 0, batteryToHouse: 2000, gridToHouse: 500, unbalancedW: 0 });
  });

  it("weist Wandlungsverluste als Ungleichgewicht aus", () => {
    const flows = computeFlows(snapshot({ pvPowerW: 1000, householdPowerW: 950 }));
    expect(flows.unbalancedW).toBe(50);
  });
});

describe("computeBalance", () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 5, 21, 10, minute)).toISOString();

  it("integriert Leistung per Trapezregel zu Energie", () => {
    // 1 h konstant 2 kW PV, davon 500 W Einspeisung
    const samples = [0, 10, 20, 30, 40, 50, 60].map((m) =>
      snapshot({ timestamp: at(m), pvPowerW: 2000, householdPowerW: 1500, gridPowerW: 500, gridDirection: "export" }),
    );
    const balance = computeBalance(samples);
    expect(balance.pvWh).toBeCloseTo(2000);
    expect(balance.gridExportWh).toBeCloseTo(500);
    expect(balance.selfConsumedWh).toBeCloseTo(1500);
    expect(balance.selfConsumptionRate).toBeCloseTo(0.75);
    expect(balance.autarkyRate).toBeCloseTo(1);
    expect(balance.coveredSeconds).toBe(3600);
  });

  it("fasst Bilanzen zusammen und berechnet Quoten neu", () => {
    const day = (pv: number, house: number, imp: number, exp: number) =>
      computeBalance([0, 60].map((m) => snapshot({ timestamp: at(m), pvPowerW: pv, householdPowerW: house, gridPowerW: imp || exp, gridDirection: imp ? "import" : "export" })), { maxGapSeconds: 3600 });
    const total = sumBalances([day(2000, 1000, 0, 1000), day(0, 1000, 1000, 0)]);
    expect(total).toMatchObject({ pvWh: 2000, householdWh: 2000, gridImportWh: 1000, gridExportWh: 1000, coveredSeconds: 7200, sampleCount: 4 });
    expect(total.autarkyRate).toBeCloseTo(0.5);
    expect(total.selfConsumptionRate).toBeCloseTo(0.5);
    expect(sumBalances([]).autarkyRate).toBeNull();
  });

  it("interpoliert nicht über Datenlücken", () => {
    const samples = [0, 5, 59].map((m) => snapshot({ timestamp: at(m), householdPowerW: 1200, gridPowerW: 1200, gridDirection: "import" }));
    const balance = computeBalance(samples, { maxGapSeconds: 10 * 60 });
    expect(balance.coveredSeconds).toBe(300);
    expect(balance.householdWh).toBeCloseTo(100);
    expect(balance.autarkyRate).toBe(0);
  });

  it("liefert ohne Daten neutrale Werte", () => {
    const balance = computeBalance([]);
    expect(balance.pvWh).toBe(0);
    expect(balance.selfConsumptionRate).toBeNull();
    expect(balance.autarkyRate).toBeNull();
  });
});

describe("assessFreshness", () => {
  const now = new Date("2026-06-21T12:00:00Z");

  it("markiert aktuelle Werte als live", () => {
    expect(assessFreshness("2026-06-21T11:59:30Z", now, 90)).toEqual({ status: "live", ageSeconds: 30 });
  });

  it("markiert alte Werte als veraltet", () => {
    expect(assessFreshness("2026-06-21T11:50:00Z", now, 90)).toEqual({ status: "stale", ageSeconds: 600 });
  });

  it("meldet fehlende Werte", () => {
    expect(assessFreshness(null, now, 90)).toEqual({ status: "unavailable", ageSeconds: null });
  });
});
