import { signedGridPower } from "./grid.js";
import type { EnergyBalance, EnergySnapshot } from "./types.js";

export interface BalanceOptions {
  /**
   * Größere Lücken zwischen zwei Messwerten werden nicht interpoliert, sondern
   * als fehlende Daten behandelt (z. B. Ausfall der API).
   */
  maxGapSeconds?: number;
}

interface Powers {
  pv: number;
  house: number;
  gridImport: number;
  gridExport: number;
  charge: number;
  discharge: number;
}

function toPowers(s: EnergySnapshot): Powers {
  const grid = signedGridPower(s);
  return {
    pv: Math.max(0, s.pvPowerW),
    house: Math.max(0, s.householdPowerW),
    gridImport: Math.max(0, grid),
    gridExport: Math.max(0, -grid),
    charge: Math.max(0, s.batteryPowerW),
    discharge: Math.max(0, -s.batteryPowerW),
  };
}

/**
 * Integriert Leistungsmesswerte (W) per Trapezregel zu Energie (Wh).
 * Die Messwerte dürfen unsortiert sein.
 */
export function computeBalance(samples: readonly EnergySnapshot[], options: BalanceOptions = {}): EnergyBalance {
  const maxGapSeconds = options.maxGapSeconds ?? 15 * 60;
  const sorted = [...samples].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  const wh: Powers = { pv: 0, house: 0, gridImport: 0, gridExport: 0, charge: 0, discharge: 0 };
  let coveredSeconds = 0;

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const curr = sorted[i]!;
    const dtSeconds = (Date.parse(curr.timestamp) - Date.parse(prev.timestamp)) / 1000;
    if (dtSeconds <= 0 || dtSeconds > maxGapSeconds) continue;

    const a = toPowers(prev);
    const b = toPowers(curr);
    const hours = dtSeconds / 3600;
    for (const key of Object.keys(wh) as (keyof Powers)[]) {
      wh[key] += ((a[key] + b[key]) / 2) * hours;
    }
    coveredSeconds += dtSeconds;
  }

  return withRates(wh, coveredSeconds, sorted.length);
}

/** Fasst Bilanzen mehrerer Zeiträume (z. B. Tage zu Monat) zusammen; Quoten werden neu berechnet. */
export function sumBalances(balances: readonly EnergyBalance[]): EnergyBalance {
  const wh: Powers = { pv: 0, house: 0, gridImport: 0, gridExport: 0, charge: 0, discharge: 0 };
  let coveredSeconds = 0;
  let sampleCount = 0;
  for (const b of balances) {
    wh.pv += b.pvWh;
    wh.house += b.householdWh;
    wh.gridImport += b.gridImportWh;
    wh.gridExport += b.gridExportWh;
    wh.charge += b.batteryChargeWh;
    wh.discharge += b.batteryDischargeWh;
    coveredSeconds += b.coveredSeconds;
    sampleCount += b.sampleCount;
  }
  return withRates(wh, coveredSeconds, sampleCount);
}

function withRates(wh: Powers, coveredSeconds: number, sampleCount: number): EnergyBalance {
  const selfConsumedWh = Math.max(0, wh.pv - wh.gridExport);
  return {
    pvWh: wh.pv,
    householdWh: wh.house,
    gridImportWh: wh.gridImport,
    gridExportWh: wh.gridExport,
    batteryChargeWh: wh.charge,
    batteryDischargeWh: wh.discharge,
    selfConsumedWh,
    selfConsumptionRate: wh.pv > 0 ? clamp01(selfConsumedWh / wh.pv) : null,
    autarkyRate: wh.house > 0 ? clamp01(1 - wh.gridImport / wh.house) : null,
    coveredSeconds,
    sampleCount,
  };
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
