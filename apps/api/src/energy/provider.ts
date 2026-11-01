import type { EnergySnapshot } from "@hef/energy-domain";

/**
 * Gemeinsame Schnittstelle für alle Datenquellen. Ein lokaler Modbus-Provider
 * kann später ergänzt werden, ohne API oder Frontend anzupassen.
 */
export interface EnergyProvider {
  readonly source: EnergySnapshot["source"];
  getCurrentSnapshot(): Promise<EnergySnapshot>;
  /** Gespeicherte Messwerte der Quelle im Intervall [start, end], falls die Quelle einen Verlauf hat */
  getHistory?(start: Date, end: Date): Promise<EnergySnapshot[]>;
}
