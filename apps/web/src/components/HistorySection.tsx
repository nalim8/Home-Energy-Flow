import type { HistoryResponse, WeatherHour } from "@hef/energy-domain";
import { useMemo } from "react";
import { formatPower } from "../format";
import type { Series } from "./chart-utils";
import { TimeSeriesChart, type TimePoint } from "./TimeSeriesChart";

const POWER_SERIES: Series[] = [
  { key: "pv", label: "PV", color: "var(--c-pv)" },
  { key: "house", label: "Haus", color: "var(--c-house)" },
  { key: "grid", label: "Netz", color: "var(--c-grid)" },
];

const SOC_SERIES: Series[] = [{ key: "soc", label: "Ladezustand", color: "var(--c-battery)" }];

const FORECAST_SERIES: Series = { key: "pvForecast", label: "PV-Prognose", color: "var(--c-pv)", dashed: true };

const wTick = (w: number) => `${w.toLocaleString("de-DE")} W`;

interface Props {
  history: HistoryResponse;
  /** Stündliche Vorhersage; Werte innerhalb des Tages werden als Prognose eingezeichnet */
  forecast?: readonly WeatherHour[];
}

export function HistorySection({ history, forecast }: Props) {
  const domain = useMemo<[number, number]>(() => [Date.parse(history.start), Date.parse(history.end)], [history]);
  const overlay = useMemo(() => {
    // Die Prognose gilt für die vorangehende Stunde und wird in deren Mitte gezeichnet
    const points = (forecast ?? [])
      .filter((h) => h.pvForecastW !== null)
      .map((h) => ({ t: Date.parse(h.time) - 30 * 60_000, value: h.pvForecastW! }))
      .filter((p) => p.t >= domain[0] && p.t <= domain[1]);
    return points.some((p) => p.value > 0) ? { series: FORECAST_SERIES, points } : undefined;
  }, [forecast, domain]);
  const points = useMemo<TimePoint[]>(
    () =>
      history.points.map((p) => ({
        t: Date.parse(p.timestamp),
        values: { pv: p.pvPowerW, house: p.householdPowerW, grid: p.gridPowerW, soc: p.batterySocPercent },
      })),
    [history],
  );

  if (points.length === 0) {
    return <p className="empty">Für diesen Tag liegen keine Messwerte vor.</p>;
  }

  return (
    <div className="history">
      <TimeSeriesChart
        title="Leistung im Tagesverlauf"
        points={points}
        series={POWER_SERIES}
        domain={domain}
        timeZone={history.timezone}
        formatValue={formatPower}
        formatTick={wTick}
        overlay={overlay}
      />
      <p className="chart-note">
        Netz: positiv = Bezug, negativ = Einspeisung. Mittelwerte über {history.bucketMinutes} Minuten.
        {overlay && " PV-Prognose: stündliche Abschätzung aus der Wettervorhersage."}
      </p>
      <TimeSeriesChart
        title="Ladezustand des Speichers"
        points={points}
        series={SOC_SERIES}
        domain={domain}
        timeZone={history.timezone}
        formatValue={(v) => `${Math.round(v)} %`}
        formatTick={(v) => `${v} %`}
        yDomain={[0, 100]}
        height={160}
      />
    </div>
  );
}
