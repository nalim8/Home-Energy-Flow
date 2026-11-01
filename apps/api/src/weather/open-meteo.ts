import type { WeatherHour, WeatherResponse } from "@hef/energy-domain";
import { z } from "zod";
import { isoDateInZone, zonedToUtc } from "../lib/time.js";

export interface Location {
  latitude: number;
  longitude: number;
}

export interface PvAssumptions {
  peakKw: number;
  /** Modulneigung, 0 = waagerecht */
  tiltDeg: number;
  /** Ausrichtung wie bei Open-Meteo: 0 = Süd, -90 = Ost, 90 = West */
  azimuthDeg: number;
  /** Anteil, der nach Verlusten (Temperatur, Wechselrichter, Verschattung) ankommt */
  performanceRatio: number;
}

export interface WeatherOptions {
  timeZone: string;
  /** Standort der Anlage; null, wenn keiner bekannt ist */
  locate: () => Promise<Location | null>;
  pv: PvAssumptions | null;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Open-Meteo rechnet stündlich neu; häufiger abzufragen bringt nichts */
  cacheMinutes?: number;
}

const BASE_URL = "https://api.open-meteo.com/v1/forecast";
const FORECAST_DAYS = 3;
/** Bei einem Ausfall von Open-Meteo bleibt eine ältere Vorhersage so lange gültig */
const STALE_LIMIT_MS = 6 * 60 * 60 * 1000;

const numbers = z.array(z.number().nullable());
const forecastSchema = z.object({
  current: z.object({
    time: z.string(),
    temperature_2m: z.number(),
    weather_code: z.number(),
    cloud_cover: z.number(),
    is_day: z.number(),
  }),
  hourly: z.object({
    time: z.array(z.string()),
    temperature_2m: numbers,
    cloud_cover: numbers,
    precipitation_probability: numbers,
    weather_code: numbers,
    global_tilted_irradiance: numbers,
  }),
  daily: z.object({
    time: z.array(z.string()),
    weather_code: numbers,
    temperature_2m_max: numbers,
    temperature_2m_min: numbers,
    sunshine_duration: numbers,
    precipitation_sum: numbers,
    sunrise: z.array(z.string()),
    sunset: z.array(z.string()),
  }),
});

/**
 * Wettervorhersage und PV-Prognose von Open-Meteo (kostenlos, ohne API-Schlüssel).
 * Die PV-Prognose ist eine Abschätzung aus der Einstrahlung auf die geneigte
 * Modulfläche: Leistung = Einstrahlung (W/m²) / 1000 × kWp × Performance Ratio.
 * Der Standort wird auf zwei Nachkommastellen (~1 km) gerundet übertragen.
 */
export class WeatherService {
  private cache: { at: number; value: WeatherResponse } | null = null;
  private readonly fetch: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: WeatherOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
  }

  async getForecast(): Promise<WeatherResponse> {
    const now = this.now().getTime();
    const maxAge = (this.options.cacheMinutes ?? 30) * 60_000;
    if (this.cache && now - this.cache.at < maxAge) return this.cache.value;

    const location = await this.options.locate();
    if (!location) {
      return { available: false, reason: "Standort unbekannt: WEATHER_LATITUDE und WEATHER_LONGITUDE setzen" };
    }
    try {
      const value = await this.load(location);
      this.cache = { at: now, value };
      return value;
    } catch (error) {
      if (this.cache && now - this.cache.at < STALE_LIMIT_MS) return this.cache.value;
      throw error;
    }
  }

  private async load(location: Location): Promise<WeatherResponse> {
    const { timeZone, pv } = this.options;
    const params = new URLSearchParams({
      latitude: location.latitude.toFixed(2),
      longitude: location.longitude.toFixed(2),
      timezone: timeZone,
      forecast_days: String(FORECAST_DAYS),
      current: "temperature_2m,weather_code,cloud_cover,is_day",
      hourly: "temperature_2m,cloud_cover,precipitation_probability,weather_code,global_tilted_irradiance",
      daily: "weather_code,temperature_2m_max,temperature_2m_min,sunshine_duration,precipitation_sum,sunrise,sunset",
      tilt: String(pv?.tiltDeg ?? 0),
      azimuth: String(pv?.azimuthDeg ?? 0),
    });
    const response = await this.fetch(`${BASE_URL}?${params}`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Open-Meteo antwortet mit HTTP ${response.status}`);
    const data = forecastSchema.parse(await response.json());

    const local = (value: string) => this.localToUtc(value);
    const factor = pv ? pv.peakKw * pv.performanceRatio : null;

    const hourly: WeatherHour[] = data.hourly.time.map((time, i) => {
      const gti = data.hourly.global_tilted_irradiance[i];
      return {
        time: local(time).toISOString(),
        temperatureC: data.hourly.temperature_2m[i] ?? 0,
        cloudCoverPercent: data.hourly.cloud_cover[i] ?? 0,
        precipitationProbabilityPercent: data.hourly.precipitation_probability[i] ?? null,
        weatherCode: data.hourly.weather_code[i] ?? 0,
        pvForecastW: factor === null || gti == null ? null : Math.round(gti * factor),
      };
    });

    // Jede Stunde zählt zu dem Tag, in dem sie beginnt
    const pvByDay = new Map<string, number>();
    for (const h of hourly) {
      if (h.pvForecastW === null) continue;
      const day = isoDateInZone(new Date(Date.parse(h.time) - 3_600_000), timeZone);
      pvByDay.set(day, (pvByDay.get(day) ?? 0) + h.pvForecastW);
    }

    return {
      available: true,
      timezone: timeZone,
      source: "Open-Meteo",
      current: {
        time: local(data.current.time).toISOString(),
        temperatureC: data.current.temperature_2m,
        weatherCode: data.current.weather_code,
        cloudCoverPercent: data.current.cloud_cover,
        isDay: data.current.is_day === 1,
      },
      days: data.daily.time.map((date, i) => ({
        date,
        weatherCode: data.daily.weather_code[i] ?? 0,
        temperatureMaxC: data.daily.temperature_2m_max[i] ?? 0,
        temperatureMinC: data.daily.temperature_2m_min[i] ?? 0,
        sunshineHours: (data.daily.sunshine_duration[i] ?? 0) / 3600,
        precipitationMm: data.daily.precipitation_sum[i] ?? 0,
        sunrise: local(data.daily.sunrise[i]!).toISOString(),
        sunset: local(data.daily.sunset[i]!).toISOString(),
        pvForecastWh: factor === null ? null : Math.round(pvByDay.get(date) ?? 0),
      })),
      hourly,
      pv,
    };
  }

  /** Open-Meteo liefert Ortszeiten ohne Zeitzone („2026-11-01T10:00“) */
  private localToUtc(value: string): Date {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
    if (!match) throw new Error(`Unerwartete Zeitangabe von Open-Meteo: ${value}`);
    const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
    return zonedToUtc({ year, month, day, hour, minute, second: 0 }, this.options.timeZone);
  }
}
