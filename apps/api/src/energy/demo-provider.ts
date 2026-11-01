import { splitGridPower, type EnergySnapshot } from "@hef/energy-domain";
import { dayOfYear, isoDateInZone, zonedParts } from "../lib/time.js";
import type { EnergyProvider } from "./provider.js";

/**
 * Synthetische, aber physikalisch konsistente Daten eines Einfamilienhauses mit
 * ~10 kWp PV und ~9,6 kWh Speicher im Eigenverbrauchsmodus. Die Werte sind frei
 * erfunden und bilden keine reale Anlage ab.
 *
 * Wetter und Lastprofil sind deterministisch aus dem Zeitpunkt abgeleitet; nur
 * der Ladezustand des Speichers ist Zustand, weil er vom Verlauf abhängt.
 */
export interface DemoPlant {
  pvPeakW: number;
  batteryCapacityWh: number;
  batteryMaxChargeW: number;
  batteryMaxDischargeW: number;
  batteryMinSocPercent: number;
  /** Anteil der Ladeenergie, der im Speicher ankommt */
  chargeEfficiency: number;
}

export const DEFAULT_PLANT: DemoPlant = {
  pvPeakW: 9_900,
  batteryCapacityWh: 9_600,
  batteryMaxChargeW: 5_000,
  batteryMaxDischargeW: 5_000,
  batteryMinSocPercent: 5,
  chargeEfficiency: 0.95,
};

/** Größter Zeitschritt, über den der Ladezustand fortgeschrieben wird */
const MAX_STEP_SECONDS = 15 * 60;

export class DemoSimulator {
  private socWh: number;
  private lastAt: number | null = null;

  constructor(
    private readonly timeZone: string,
    private readonly plant: DemoPlant = DEFAULT_PLANT,
    initialSocPercent = 40,
  ) {
    this.socWh = (initialSocPercent / 100) * plant.batteryCapacityWh;
  }

  /** Erzeugt den Messwert zum Zeitpunkt `at` und schreibt den Speicher fort. */
  sample(at: Date): EnergySnapshot {
    const pv = Math.round(pvPower(at, this.plant.pvPeakW));
    const house = Math.round(householdPower(at, this.timeZone));

    const t = at.getTime();
    const dtHours = this.lastAt === null ? 0 : Math.min(Math.max(0, t - this.lastAt) / 1000, MAX_STEP_SECONDS) / 3600;
    this.lastAt = t;

    const { batteryCapacityWh, batteryMinSocPercent, batteryMaxChargeW, batteryMaxDischargeW, chargeEfficiency } =
      this.plant;
    const minWh = (batteryMinSocPercent / 100) * batteryCapacityWh;

    let batteryW = 0;
    const surplus = pv - house;
    if (surplus > 0) {
      const roomW = dtHours > 0 ? (batteryCapacityWh - this.socWh) / chargeEfficiency / dtHours : batteryMaxChargeW;
      batteryW = Math.min(surplus, batteryMaxChargeW, roomW);
    } else if (surplus < 0) {
      const availableW = dtHours > 0 ? (this.socWh - minWh) / dtHours : batteryMaxDischargeW;
      batteryW = -Math.min(-surplus, batteryMaxDischargeW, availableW);
    }
    batteryW = Math.round(Math.max(batteryW, -batteryMaxDischargeW));
    if (Math.abs(batteryW) < 10) batteryW = 0;

    this.socWh += batteryW > 0 ? batteryW * chargeEfficiency * dtHours : batteryW * dtHours;
    this.socWh = Math.min(batteryCapacityWh, Math.max(0, this.socWh));

    // Bilanz am Netzanschlusspunkt: Bezug deckt, was PV und Speicher nicht liefern
    const signedGridW = house + Math.max(0, batteryW) - pv - Math.max(0, -batteryW);

    return {
      timestamp: at.toISOString(),
      pvPowerW: pv,
      householdPowerW: house,
      batteryPowerW: batteryW,
      batterySocPercent: Math.round((this.socWh / batteryCapacityWh) * 1000) / 10,
      ...splitGridPower(signedGridW),
      source: "demo",
    };
  }
}

export class DemoEnergyProvider implements EnergyProvider {
  readonly source = "demo" as const;
  private readonly simulator: DemoSimulator;

  constructor(
    timeZone: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.simulator = new DemoSimulator(timeZone);
  }

  /**
   * Simuliert vergangene Messwerte, damit Historie und Tagesbilanz sofort
   * gefüllt sind. Muss vor dem ersten Live-Abruf aufgerufen werden.
   */
  backfill(from: Date, to: Date, stepSeconds = 60): EnergySnapshot[] {
    const result: EnergySnapshot[] = [];
    const stepMs = stepSeconds * 1000;
    for (let t = Math.ceil(from.getTime() / stepMs) * stepMs; t < to.getTime(); t += stepMs) {
      result.push(this.simulator.sample(new Date(t)));
    }
    return result;
  }

  async getCurrentSnapshot(): Promise<EnergySnapshot> {
    return this.simulator.sample(this.now());
  }
}

// --- Modell -----------------------------------------------------------------

/** Jahreszeitlicher Verlauf: -1 zur Wintersonnenwende, +1 zur Sommersonnenwende */
const season = (doy: number) => Math.sin((2 * Math.PI * (doy - 80)) / 365);

/**
 * PV-Leistung aus Sonnenstand und Bewölkung. Gerechnet wird in UTC, damit
 * Sommerzeitwechsel keinen Sprung erzeugen (Sonnenmittag in Mitteleuropa ≈ 11:20 UTC).
 */
export function pvPower(at: Date, peakW: number): number {
  const utcDate = at.toISOString().slice(0, 10);
  const s = season(dayOfYear(utcDate));
  const dayLengthHours = 12 + 4.3 * s;
  const solarNoonUtc = 11.35;
  const hour = at.getUTCHours() + at.getUTCMinutes() / 60 + at.getUTCSeconds() / 3600;
  const x = (hour - (solarNoonUtc - dayLengthHours / 2)) / dayLengthHours;
  if (x <= 0 || x >= 1) return 0;

  const elevation = Math.sin(Math.PI * x) ** 1.4;
  const seasonalPeak = 0.3 + 0.48 * (0.5 + 0.5 * s);
  return peakW * seasonalPeak * elevation * cloudFactor(at);
}

function cloudFactor(at: Date): number {
  const dayIndex = Math.floor(at.getTime() / 86_400_000);
  const weather = hash01(dayIndex * 7919);
  const [base, variation] = weather < 0.45 ? [0.95, 0.08] : weather < 0.8 ? [0.62, 0.38] : [0.22, 0.1];
  // Wolkenzüge: geglättetes Rauschen mit 10-Minuten-Stützstellen
  const noise = smoothNoise(at.getTime() / 600_000, dayIndex);
  return clamp(base + variation * (noise * 2 - 1), 0.04, 1);
}

/** Hausverbrauch aus typischem Tagesprofil und gelegentlichen Großverbrauchern */
export function householdPower(at: Date, timeZone: string): number {
  const p = zonedParts(at, timeZone);
  const hour = p.hour + p.minute / 60 + p.second / 3600;
  const date = isoDateInZone(at, timeZone);
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const weekend = weekday === 0 || weekday === 6;
  const dayIndex = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);

  let watts = 260;
  // Kühlschrank taktet
  watts += (p.minute % 20) < 8 ? 90 : 0;
  watts += bump(hour, weekend ? 8.5 : 6.8, 0.6, 850);
  watts += bump(hour, 12.4, 0.6, weekend ? 1600 : 900);
  watts += bump(hour, 19, 1.6, 1100);
  if (weekend) watts += bump(hour, 15, 2.5, 350);

  // Waschmaschine bzw. Spülmaschine an manchen Tagen
  const applianceStart = 9.5 + hash01(dayIndex * 31) * 5;
  if (hash01(dayIndex * 17) < 0.5 && hour >= applianceStart && hour < applianceStart + 1.5) {
    watts += hour < applianceStart + 0.3 ? 2000 : 250;
  }

  // Kurze Lastspitzen (Wasserkocher, Herdplatte)
  const minuteIndex = Math.floor(at.getTime() / 60_000);
  if (hour > 6 && hour < 23 && hash01(minuteIndex) > 0.965) watts += 1800;

  // Messrauschen
  watts *= 0.94 + 0.12 * smoothNoise(at.getTime() / 120_000, 3);
  return watts;
}

const bump = (x: number, center: number, width: number, height: number) =>
  height * Math.exp(-((x - center) ** 2) / (2 * width ** 2));

const clamp = (x: number, min: number, max: number) => Math.min(max, Math.max(min, x));

/** Deterministischer Pseudozufall in [0, 1) */
function hash01(n: number): number {
  let h = Math.imul(Math.floor(n) ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4_294_967_296;
}

/** Kosinus-interpoliertes Rauschen in [0, 1) */
function smoothNoise(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const a = hash01(i * 374_761 + seed * 668_265);
  const b = hash01((i + 1) * 374_761 + seed * 668_265);
  const t = (1 - Math.cos(Math.PI * f)) / 2;
  return a + (b - a) * t;
}
