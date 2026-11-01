import type { EnergySnapshot, GridDirection } from "./types.js";

/** Unterhalb dieser Leistung gilt der Netzanschluss als neutral (Messrauschen). */
export const GRID_IDLE_THRESHOLD_W = 20;

/**
 * Wandelt eine vorzeichenbehaftete Netzleistung (> 0 = Bezug, < 0 = Einspeisung)
 * in Betrag und Richtung um.
 */
export function splitGridPower(
  signedW: number,
  idleThresholdW = GRID_IDLE_THRESHOLD_W,
): { gridPowerW: number; gridDirection: GridDirection } {
  const magnitude = Math.abs(signedW);
  if (magnitude < idleThresholdW) return { gridPowerW: 0, gridDirection: "idle" };
  return { gridPowerW: magnitude, gridDirection: signedW > 0 ? "import" : "export" };
}

/** Netzleistung mit Vorzeichen: > 0 = Bezug, < 0 = Einspeisung */
export function signedGridPower(snapshot: Pick<EnergySnapshot, "gridPowerW" | "gridDirection">): number {
  switch (snapshot.gridDirection) {
    case "import":
      return snapshot.gridPowerW;
    case "export":
      return -snapshot.gridPowerW;
    case "idle":
      return 0;
  }
}
