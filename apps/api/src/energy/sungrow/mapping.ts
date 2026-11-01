import { splitGridPower, type EnergySnapshot } from "@hef/energy-domain";
import { zonedToUtc } from "../../lib/time.js";
import type { RealtimePoint } from "./client.js";

/**
 * Jeder Eintrag ist ein Messpunkt-Ausdruck: "83106" liest den Punkt der Anlage,
 * "14:13149" den eines Geräts vom Typ 14, "14:13149-13121" die Differenz zweier
 * Gerätepunkte (z. B. Netzbezug minus Einspeisung).
 */
export interface PointMapping {
  pv: string;
  load: string;
  grid: string;
  /** Leer: Batterieleistung aus der Bilanz berechnen */
  battery: string;
  soc: string;
  /** Vorzeichen, mit dem Sungrow Netzbezug meldet */
  gridImportSign: "positive" | "negative";
  /** Vorzeichen, mit dem Sungrow das Laden meldet */
  batteryChargeSign: "positive" | "negative";
}

export class SungrowMappingError extends Error {
  override readonly name = "SungrowMappingError";
}

export interface PointTerm {
  /** Gerätetyp; null für Punkte der Anlage */
  deviceType: number | null;
  id: string;
  sign: 1 | -1;
  /** Schlüssel in der Messpunkt-Map: "83106" bzw. "14:13149" */
  key: string;
}

export function pointKey(deviceType: number | null, id: string): string {
  return deviceType === null ? id : `${deviceType}:${id}`;
}

export function parsePointSpec(spec: string): PointTerm[] {
  const match = /^\s*(?:(\d+):)?(\d+(?:\s*-\s*\d+)*)\s*$/.exec(spec);
  if (!match) throw new SungrowMappingError(`Ungültiger Messpunkt-Ausdruck „${spec}“`);
  const deviceType = match[1] ? Number(match[1]) : null;
  return match[2]!.split("-").map((raw, index) => {
    const id = raw.trim();
    return { deviceType, id, sign: index === 0 ? 1 : -1, key: pointKey(deviceType, id) };
  });
}

/** Leistung eines Ausdrucks in Watt (Summe der Terme mit Vorzeichen). */
export function specPowerW(points: ReadonlyMap<string, RealtimePoint>, spec: string, label: string): number {
  return parsePointSpec(spec).reduce((sum, term) => sum + term.sign * powerW(points.get(term.key), label), 0);
}

/** Sungrow-Zeitstempel „yyyyMMddHHmmss“ in Ortszeit der Anlage; null, wenn nicht lesbar */
export function parseDeviceTime(value: unknown, timeZone: string): Date | null {
  const match = typeof value === "string" ? /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value) : null;
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [number, number, number, number, number, number];
  return zonedToUtc({ year, month, day, hour, minute, second }, timeZone);
}

function singlePoint(points: ReadonlyMap<string, RealtimePoint>, spec: string): RealtimePoint | undefined {
  const terms = parsePointSpec(spec);
  if (terms.length !== 1) throw new SungrowMappingError(`Ladezustand: Differenz „${spec}“ nicht möglich`);
  return points.get(terms[0]!.key);
}

/** Leistung in Watt; kW-Werte werden umgerechnet. */
export function powerW(point: RealtimePoint | undefined, label: string): number {
  const value = numeric(point, label);
  const unit = point!.unit?.trim().toLowerCase();
  if (unit === "kw") return value * 1000;
  if (unit === "mw") return value * 1_000_000;
  if (unit && unit !== "w") throw new SungrowMappingError(`${label}: unerwartete Einheit „${point!.unit}“`);
  return value;
}

/** Ladezustand in Prozent. Ohne %-Einheit liefert Sungrow einen Anteil (0–1). */
export function socPercent(point: RealtimePoint | undefined): number {
  const value = numeric(point, "Ladezustand");
  const percent = point!.unit?.trim() === "%" ? value : value <= 1 ? value * 100 : value;
  return Math.min(100, Math.max(0, percent));
}

function numeric(point: RealtimePoint | undefined, label: string): number {
  if (!point) throw new SungrowMappingError(`${label}: Messpunkt fehlt in der Antwort`);
  const value = typeof point.value === "number" ? point.value : Number(point.value);
  if (point.value === null || point.value === "" || !Number.isFinite(value)) {
    throw new SungrowMappingError(`${label} (p${point.id}): kein Zahlenwert („${point.value}“)`);
  }
  return value;
}

/**
 * Übersetzt Sungrow-Messpunkte in das herstellerunabhängige Modell. Fehlt ein
 * Pflichtwert, wird ein Fehler geworfen – lieber kein Messwert als ein falscher.
 */
export function mapRealtime(
  points: ReadonlyMap<string, RealtimePoint>,
  mapping: PointMapping,
  timestamp: Date,
): EnergySnapshot {
  const pv = Math.max(0, specPowerW(points, mapping.pv, "PV-Leistung"));
  const load = Math.max(0, specPowerW(points, mapping.load, "Hausverbrauch"));
  const rawGrid = specPowerW(points, mapping.grid, "Netzleistung");
  const signedGrid = mapping.gridImportSign === "positive" ? rawGrid : -rawGrid;

  let battery: number;
  if (mapping.battery) {
    const raw = specPowerW(points, mapping.battery, "Batterieleistung");
    battery = mapping.batteryChargeSign === "positive" ? raw : -raw;
  } else {
    // Energieerhaltung am Wechselrichter: was nicht ins Haus oder Netz geht, lädt den Speicher
    battery = pv + signedGrid - load;
  }

  return {
    timestamp: timestamp.toISOString(),
    pvPowerW: Math.round(pv),
    householdPowerW: Math.round(load),
    batteryPowerW: Math.round(battery),
    batterySocPercent: Math.round(socPercent(singlePoint(points, mapping.soc)) * 10) / 10,
    ...splitGridPower(Math.round(signedGrid)),
    source: "sungrow-cloud",
  };
}
