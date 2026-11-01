import type { WeatherResponse } from "@hef/energy-domain";
import { formatDate, formatEnergy, formatTime, shiftDate } from "../format";
import { describeWeather } from "../weather";
import { Icon } from "./Icon";

const temperature = (c: number) => `${Math.round(c).toLocaleString("de-DE")} °C`;
const hours = (h: number) => `${h.toLocaleString("de-DE", { maximumFractionDigits: 1 })} h`;

function dayLabel(date: string, today: string): string {
  if (date === today) return "Heute";
  if (date === shiftDate(today, 1)) return "Morgen";
  return formatDate(date, "weekday");
}

interface Props {
  weather: WeatherResponse | null;
  error: string | null;
  today: string;
}

/** Aktuelles Wetter und Vorhersage für drei Tage mit erwartetem PV-Ertrag */
export function WeatherCard({ weather, error, today }: Props) {
  return (
    <section className="card" aria-labelledby="weather-title">
      <div className="card-header">
        <h2 id="weather-title">Wetter & PV-Prognose</h2>
        {weather?.available && <span className="card-source">{weather.source}</span>}
      </div>
      <WeatherBody weather={weather} error={error} today={today} />
    </section>
  );
}

function WeatherBody({ weather, error, today }: Props) {
  if (!weather) {
    return error ? (
      <p className="status status-critical" role="alert">
        <Icon name="alert" size={16} /> {error}
      </p>
    ) : (
      <div className="skeleton" aria-label="Lade" />
    );
  }
  if (!weather.available) return <p className="empty">{weather.reason}</p>;

  const now = describeWeather(weather.current.weatherCode, weather.current.isDay);
  return (
    <>
      <div className="weather-now">
        <Icon name={now.icon} size={44} className="weather-icon" />
        <div>
          <div className="weather-temp">{temperature(weather.current.temperatureC)}</div>
          <div className="weather-label">
            {now.label} · Bewölkung {Math.round(weather.current.cloudCoverPercent)} %
          </div>
        </div>
      </div>

      <ul className="weather-days">
        {weather.days.map((day) => {
          const d = describeWeather(day.weatherCode);
          return (
            <li key={day.date} className="weather-day">
              <div className="weather-day-name">{dayLabel(day.date, today)}</div>
              <Icon name={d.icon} size={28} className="weather-icon" />
              <div className="weather-day-temp">
                {Math.round(day.temperatureMaxC)}° <span className="muted">/ {Math.round(day.temperatureMinC)}°</span>
              </div>
              <div className="weather-day-detail">
                {d.label}
                <br />
                {hours(day.sunshineHours)} Sonne
                {day.precipitationMm >= 0.1 && ` · ${day.precipitationMm.toLocaleString("de-DE", { maximumFractionDigits: 1 })} mm`}
              </div>
              {day.pvForecastWh !== null && (
                <div className="weather-day-pv">
                  <Icon name="sun" size={14} /> ≈ {formatEnergy(day.pvForecastWh)}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {weather.pv ? (
        <p className="chart-note">
          PV-Prognose aus der Einstrahlung für {weather.pv.peakKw.toLocaleString("de-DE")} kWp, {weather.pv.tiltDeg}° Neigung,{" "}
          {azimuthLabel(weather.pv.azimuthDeg)}. Sonnenaufgang {formatTime(weather.days[0]!.sunrise, weather.timezone)}, -untergang{" "}
          {formatTime(weather.days[0]!.sunset, weather.timezone)} Uhr.
        </p>
      ) : (
        <p className="chart-note">Für eine PV-Prognose die Anlagenleistung als PV_PEAK_KW eintragen.</p>
      )}
    </>
  );
}

function azimuthLabel(deg: number): string {
  const directions: [number, string][] = [
    [-180, "Nord"],
    [-135, "Nordost"],
    [-90, "Ost"],
    [-45, "Südost"],
    [0, "Süd"],
    [45, "Südwest"],
    [90, "West"],
    [135, "Nordwest"],
    [180, "Nord"],
  ];
  const [, name] = directions.reduce((best, d) => (Math.abs(d[0] - deg) < Math.abs(best[0] - deg) ? d : best));
  return `Ausrichtung ${name}`;
}
