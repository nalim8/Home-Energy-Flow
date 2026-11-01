/**
 * Antwortformate der REST-API. Backend und Frontend verwenden dieselben Typen,
 * damit Änderungen am Vertrag sofort im Typecheck auffallen.
 */
import type { EnergyBalance, EnergyFlows, EnergySnapshot, EnergySource, Freshness } from "./types.js";

export interface PollStatus {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  /** Fehlermeldung des letzten Abrufs, null wenn er erfolgreich war */
  lastError: string | null;
  /** Maschinenlesbarer Grund, z. B. "auth_required" bei fehlender Sungrow-Autorisierung */
  lastErrorCode: string | null;
  consecutiveFailures: number;
}

/** GET /api/energy/current */
export interface CurrentEnergyResponse {
  /** Letzter gespeicherter Messwert; kann veraltet sein, siehe freshness */
  snapshot: EnergySnapshot | null;
  flows: EnergyFlows | null;
  freshness: Freshness;
  poll: PollStatus;
}

/** Gemittelter Messwert eines Zeitfensters */
export interface HistoryPoint {
  timestamp: string;
  pvPowerW: number;
  householdPowerW: number;
  /** > 0 = Laden, < 0 = Entladen */
  batteryPowerW: number;
  batterySocPercent: number;
  /** > 0 = Bezug, < 0 = Einspeisung */
  gridPowerW: number;
}

/** GET /api/energy/history?date=YYYY-MM-DD */
export interface HistoryResponse {
  date: string;
  timezone: string;
  /** Lokale Mitternacht als ISO-Zeitstempel; Tage können 23–25 h lang sein */
  start: string;
  end: string;
  bucketMinutes: number;
  points: HistoryPoint[];
}

/** GET /api/energy/balance?date=YYYY-MM-DD */
export interface DailyBalanceResponse {
  date: string;
  timezone: string;
  balance: EnergyBalance;
}

/** GET /api/energy/balance/daily?days=N, älteste zuerst */
export interface DailyBalancesResponse {
  timezone: string;
  days: { date: string; balance: EnergyBalance }[];
}

/** GET /api/energy/balance/range?from=YYYY-MM-DD&to=YYYY-MM-DD, Tage älteste zuerst */
export interface RangeBalanceResponse {
  from: string;
  to: string;
  timezone: string;
  total: EnergyBalance;
  days: { date: string; balance: EnergyBalance }[];
  /** true, solange fehlende Werte des Zeitraums aus der Datenquelle nachgeladen werden */
  backfilling: boolean;
}

/** GET /api/meta */
export interface MetaResponse {
  source: EnergySource;
  timezone: string;
  pollIntervalSeconds: number;
  staleAfterSeconds: number;
  /** true, wenn synthetische Daten angezeigt werden */
  demo: boolean;
  /** Messwerte älter als so viele Tage werden gelöscht */
  retentionDays: number;
}

/** Wetterlage nach WMO-Code (Open-Meteo) */
export interface WeatherNow {
  time: string;
  temperatureC: number;
  weatherCode: number;
  cloudCoverPercent: number;
  isDay: boolean;
}

export interface WeatherDay {
  /** Kalendertag in der Zeitzone der Anlage */
  date: string;
  weatherCode: number;
  temperatureMaxC: number;
  temperatureMinC: number;
  sunshineHours: number;
  precipitationMm: number;
  sunrise: string;
  sunset: string;
  /** Erwarteter PV-Ertrag, null ohne konfigurierte Anlagenleistung */
  pvForecastWh: number | null;
}

export interface WeatherHour {
  /** Ende der Stunde (UTC); Einstrahlung und PV-Prognose sind Mittelwerte der vorangehenden Stunde */
  time: string;
  temperatureC: number;
  cloudCoverPercent: number;
  precipitationProbabilityPercent: number | null;
  weatherCode: number;
  pvForecastW: number | null;
}

/** GET /api/weather */
export type WeatherResponse =
  | {
      available: true;
      timezone: string;
      source: "Open-Meteo";
      current: WeatherNow;
      days: WeatherDay[];
      hourly: WeatherHour[];
      /** Annahmen der PV-Prognose, null ohne konfigurierte Anlagenleistung */
      pv: { peakKw: number; tiltDeg: number; azimuthDeg: number; performanceRatio: number } | null;
    }
  | { available: false; reason: string };
