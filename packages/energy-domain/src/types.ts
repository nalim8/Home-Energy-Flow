/**
 * Herstellerunabhängiges Datenmodell. Provider (Sungrow-Cloud, Modbus, Demo)
 * übersetzen ihre Rohdaten in dieses Format.
 *
 * Vorzeichenkonvention:
 * - pvPowerW, householdPowerW: immer >= 0
 * - batteryPowerW: > 0 = Laden, < 0 = Entladen
 * - gridPowerW: Betrag (>= 0), die Richtung steht in gridDirection
 */
export type GridDirection = "import" | "export" | "idle";

export type EnergySource = "sungrow-cloud" | "sungrow-modbus" | "demo";

export interface EnergySnapshot {
  /** ISO-8601-Zeitstempel der Messung (nicht des Abrufs) */
  timestamp: string;
  pvPowerW: number;
  householdPowerW: number;
  batteryPowerW: number;
  batterySocPercent: number;
  gridPowerW: number;
  gridDirection: GridDirection;
  source: EnergySource;
}

/** Leistungsflüsse zwischen den Knoten in Watt, jeweils >= 0 */
export interface EnergyFlows {
  pvToHouse: number;
  pvToBattery: number;
  pvToGrid: number;
  batteryToHouse: number;
  batteryToGrid: number;
  gridToHouse: number;
  gridToBattery: number;
  /**
   * Differenz zwischen Quellen und Senken. Ungleich 0 bei Wandlungsverlusten,
   * Messungenauigkeiten oder unterschiedlichen Messzeitpunkten.
   */
  unbalancedW: number;
}

/** Tagesbilanz in Wattstunden */
export interface EnergyBalance {
  pvWh: number;
  householdWh: number;
  gridImportWh: number;
  gridExportWh: number;
  batteryChargeWh: number;
  batteryDischargeWh: number;
  /** Direkt oder über den Speicher selbst genutzter PV-Strom */
  selfConsumedWh: number;
  /** Anteil des PV-Stroms, der nicht eingespeist wurde (0–1), null ohne PV */
  selfConsumptionRate: number | null;
  /** Anteil des Verbrauchs, der nicht aus dem Netz kam (0–1), null ohne Verbrauch */
  autarkyRate: number | null;
  /** Zeitraum in Sekunden, der durch Messwerte abgedeckt ist */
  coveredSeconds: number;
  sampleCount: number;
}

export type FreshnessStatus = "live" | "stale" | "unavailable";

export interface Freshness {
  status: FreshnessStatus;
  /** Alter des letzten Messwerts in Sekunden, null wenn keiner existiert */
  ageSeconds: number | null;
}
