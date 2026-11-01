import { describe, expect, it } from "vitest";
import { WeatherService, type PvAssumptions } from "../src/weather/open-meteo.js";

const PV: PvAssumptions = { peakKw: 10, tiltDeg: 30, azimuthDeg: 0, performanceRatio: 0.8 };

/** Antwort von Open-Meteo in Ortszeit (Europe/Berlin, MEZ = UTC+1) */
const FORECAST = {
  current: { time: "2026-11-01T10:45", temperature_2m: 8.2, weather_code: 2, cloud_cover: 87, is_day: 1 },
  hourly: {
    time: ["2026-11-01T00:00", "2026-11-01T11:00", "2026-11-01T12:00", "2026-11-02T00:00", "2026-11-02T12:00"],
    temperature_2m: [3, 8, 9, 2, 7],
    cloud_cover: [100, 50, 40, 90, 10],
    precipitation_probability: [0, 5, null, 0, 0],
    weather_code: [3, 2, 1, 3, 0],
    // Einstrahlung (W/m²) als Mittel der vorangehenden Stunde
    global_tilted_irradiance: [0, 250, 500, 0, null],
  },
  daily: {
    time: ["2026-11-01", "2026-11-02"],
    weather_code: [3, 45],
    temperature_2m_max: [10.4, 8.4],
    temperature_2m_min: [2.9, 1.2],
    sunshine_duration: [27000, 0],
    precipitation_sum: [0, 1.5],
    sunrise: ["2026-11-01T07:03", "2026-11-02T07:05"],
    sunset: ["2026-11-01T16:54", "2026-11-02T16:52"],
  },
};

function fakeOpenMeteo(body: unknown = FORECAST, status = 200) {
  const urls: URL[] = [];
  const fetchFn = (async (input: string | URL) => {
    urls.push(new URL(String(input)));
    return Response.json(body, { status });
  }) as typeof fetch;
  return { fetchFn, urls };
}

describe("WeatherService", () => {
  it("rechnet Ortszeiten nach UTC um und schätzt den PV-Ertrag", async () => {
    const { fetchFn, urls } = fakeOpenMeteo();
    const service = new WeatherService({
      timeZone: "Europe/Berlin",
      locate: async () => ({ latitude: 52.52008, longitude: 13.40495 }),
      pv: PV,
      fetch: fetchFn,
    });

    const forecast = await service.getForecast();
    if (!forecast.available) throw new Error("Vorhersage erwartet");

    // Standort nur auf ~1 km genau übertragen
    expect(urls[0]!.searchParams.get("latitude")).toBe("52.52");
    expect(urls[0]!.searchParams.get("longitude")).toBe("13.40");
    expect(urls[0]!.searchParams.get("tilt")).toBe("30");

    expect(forecast.current).toEqual({ time: "2026-11-01T09:45:00.000Z", temperatureC: 8.2, weatherCode: 2, cloudCoverPercent: 87, isDay: true });
    // 500 W/m² × 10 kWp × 0,8 = 4000 W
    expect(forecast.hourly[2]).toMatchObject({ time: "2026-11-01T11:00:00.000Z", pvForecastW: 4000, precipitationProbabilityPercent: null });
    expect(forecast.hourly[4]!.pvForecastW).toBeNull();
    // Die Stunde bis 00:00 am 2.11. gehört noch zum 1.11.
    expect(forecast.days.map((d) => d.pvForecastWh)).toEqual([6000, 0]);
    expect(forecast.days[0]).toMatchObject({ sunshineHours: 7.5, sunrise: "2026-11-01T06:03:00.000Z" });
  });

  it("liefert ohne Anlagenleistung keine PV-Prognose", async () => {
    const service = new WeatherService({
      timeZone: "Europe/Berlin",
      locate: async () => ({ latitude: 49.4, longitude: 11.1 }),
      pv: null,
      fetch: fakeOpenMeteo().fetchFn,
    });
    const forecast = await service.getForecast();
    expect(forecast.available && forecast.days[0]!.pvForecastWh).toBeNull();
    expect(forecast.available && forecast.pv).toBeNull();
  });

  it("meldet einen fehlenden Standort", async () => {
    const service = new WeatherService({ timeZone: "Europe/Berlin", locate: async () => null, pv: PV, fetch: fakeOpenMeteo().fetchFn });
    expect(await service.getForecast()).toMatchObject({ available: false });
  });

  it("puffert die Vorhersage und überbrückt kurze Ausfälle", async () => {
    let now = Date.parse("2026-11-01T10:00:00Z");
    let calls = 0;
    let failing = false;
    const fetchFn = (async () => {
      calls += 1;
      return failing ? new Response("down", { status: 503 }) : Response.json(FORECAST);
    }) as unknown as typeof fetch;
    const service = new WeatherService({
      timeZone: "Europe/Berlin",
      locate: async () => ({ latitude: 49.4, longitude: 11.1 }),
      pv: PV,
      fetch: fetchFn,
      now: () => new Date(now),
    });

    await service.getForecast();
    await service.getForecast();
    expect(calls).toBe(1);

    now += 60 * 60_000;
    failing = true;
    expect((await service.getForecast()).available).toBe(true);
    expect(calls).toBe(2);

    now += 7 * 60 * 60_000;
    await expect(service.getForecast()).rejects.toThrow("HTTP 503");
  });
});
