import { signedGridPower } from "./grid.js";
import type { EnergyFlows, EnergySnapshot } from "./types.js";

/**
 * Teilt die gemessenen Leistungen auf einzelne Flüsse auf.
 *
 * Gemessen werden nur die Leistungen an den vier Knoten. Wer wen versorgt, ist
 * eine Modellannahme: PV versorgt zuerst das Haus, dann den Speicher, der Rest
 * wird eingespeist. Das Haus bezieht Fehlmengen zuerst aus dem Speicher, dann
 * aus dem Netz. Das entspricht dem Eigenverbrauchsmodus eines Hybridwechselrichters.
 */
export function computeFlows(snapshot: EnergySnapshot): EnergyFlows {
  const pv = Math.max(0, snapshot.pvPowerW);
  const house = Math.max(0, snapshot.householdPowerW);
  const charge = Math.max(0, snapshot.batteryPowerW);
  const discharge = Math.max(0, -snapshot.batteryPowerW);
  const grid = signedGridPower(snapshot);
  const gridImport = Math.max(0, grid);
  const gridExport = Math.max(0, -grid);

  const pvToHouse = Math.min(pv, house);
  const pvToBattery = Math.min(pv - pvToHouse, charge);
  const pvToGrid = Math.min(pv - pvToHouse - pvToBattery, gridExport);

  const batteryToHouse = Math.min(discharge, house - pvToHouse);
  const gridToHouse = Math.min(gridImport, house - pvToHouse - batteryToHouse);

  const gridToBattery = Math.min(gridImport - gridToHouse, charge - pvToBattery);
  const batteryToGrid = Math.min(discharge - batteryToHouse, gridExport - pvToGrid);

  const sources = pv + gridImport + discharge;
  const sinks = house + charge + gridExport;

  return {
    pvToHouse,
    pvToBattery,
    pvToGrid,
    batteryToHouse,
    batteryToGrid,
    gridToHouse,
    gridToBattery,
    unbalancedW: sources - sinks,
  };
}
