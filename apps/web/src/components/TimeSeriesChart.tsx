import { useMemo, useState, type PointerEvent } from "react";
import { formatTime } from "../format";
import { useElementWidth } from "../hooks";
import { niceTicks, spreadLabels, type Series } from "./chart-utils";
import { Legend } from "./Legend";

export interface TimePoint {
  t: number;
  values: Record<string, number>;
}

interface Props {
  title: string;
  points: readonly TimePoint[];
  series: readonly Series[];
  /** Darzustellender Zeitraum (ms), z. B. der ganze Kalendertag */
  domain: [number, number];
  timeZone: string;
  formatValue: (value: number) => string;
  formatTick: (value: number) => string;
  /** Feste Wertebereiche, z. B. 0–100 % */
  yDomain?: [number, number];
  height?: number;
  /** Lücken über dieser Dauer werden nicht verbunden */
  maxGapMs?: number;
  /** Zusätzliche gestrichelte Linie mit eigenen Zeitpunkten, z. B. eine Prognose */
  overlay?: { series: Series; points: readonly { t: number; value: number }[] };
}

/** Im Tooltip wird der Overlay-Wert gezeigt, der höchstens so weit entfernt liegt */
const OVERLAY_TOOLTIP_MS = 45 * 60_000;

const MARGIN = { top: 12, right: 72, bottom: 26, left: 52 };

export function TimeSeriesChart({
  title,
  points,
  series,
  domain,
  timeZone,
  formatValue,
  formatTick,
  yDomain,
  height = 260,
  maxGapMs = 20 * 60_000,
  overlay,
}: Props) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const innerW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerH = height - MARGIN.top - MARGIN.bottom;

  const { yTicks, yMin, yMax } = useMemo(() => {
    if (yDomain) return { yTicks: niceTicks(yDomain[0], yDomain[1], 4), yMin: yDomain[0], yMax: yDomain[1] };
    let min = 0;
    let max = 0;
    for (const p of points) for (const s of series) {
      const v = p.values[s.key] ?? 0;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    for (const p of overlay?.points ?? []) if (p.value > max) max = p.value;
    const ticks = niceTicks(min, max || 1000, 4);
    return { yTicks: ticks, yMin: ticks[0]!, yMax: ticks.at(-1)! };
  }, [points, series, yDomain, overlay]);

  const x = (t: number) => MARGIN.left + ((t - domain[0]) / (domain[1] - domain[0])) * innerW;
  const y = (v: number) => MARGIN.top + (1 - (v - yMin) / (yMax - yMin)) * innerH;

  const xTicks = useMemo(() => {
    const ticks: number[] = [];
    const stepMs = (innerW < 420 ? 6 : 3) * 3_600_000;
    for (let t = domain[0]; t <= domain[1]; t += stepMs) ticks.push(t);
    return ticks;
  }, [domain, innerW]);

  const paths = series.map((s) => {
    let d = "";
    let prevT: number | null = null;
    for (const p of points) {
      const cmd = prevT === null || p.t - prevT > maxGapMs ? "M" : "L";
      d += `${cmd}${x(p.t).toFixed(1)},${y(p.values[s.key] ?? 0).toFixed(1)}`;
      prevT = p.t;
    }
    return { series: s, d };
  });

  const overlayPath = overlay
    ? overlay.points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)},${y(p.value).toFixed(1)}`).join("")
    : "";

  const last = points.at(-1);
  const endLabels = last
    ? spreadLabels(
        series.map((s) => ({ series: s, y: y(last.values[s.key] ?? 0) })),
        15,
        MARGIN.top + 4,
        MARGIN.top + innerH,
      )
    : [];

  const onPointerMove = (event: PointerEvent<SVGRectElement>) => {
    if (points.length === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const t = domain[0] + ((event.clientX - rect.left) / rect.width) * (domain[1] - domain[0]);
    let best = 0;
    for (let i = 1; i < points.length; i++) {
      if (Math.abs(points[i]!.t - t) < Math.abs(points[best]!.t - t)) best = i;
    }
    setHover(best);
  };

  const hovered = hover !== null ? points[hover] : undefined;
  const tooltipLeft = hovered ? x(hovered.t) : 0;
  const hoveredOverlay =
    hovered && overlay
      ? overlay.points.reduce<{ t: number; value: number } | null>((best, p) => {
          const distance = Math.abs(p.t - hovered.t);
          return distance <= OVERLAY_TOOLTIP_MS && (!best || distance < Math.abs(best.t - hovered.t)) ? p : best;
        }, null)
      : null;
  const legendSeries = overlay ? [...series, overlay.series] : series;

  return (
    <figure className="chart">
      <figcaption className="chart-title">{title}</figcaption>
      {legendSeries.length > 1 && <Legend series={legendSeries} />}
      <div ref={ref} className="chart-canvas" style={{ height }}>
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label={`${title}, Details in der Tabelle`}>
            {yTicks.map((v) => (
              <g key={v}>
                <line
                  className={v === 0 ? "axis-zero" : "grid-line"}
                  x1={MARGIN.left}
                  x2={MARGIN.left + innerW}
                  y1={y(v)}
                  y2={y(v)}
                />
                <text className="tick" x={MARGIN.left - 8} y={y(v)} dy="0.32em" textAnchor="end">
                  {formatTick(v)}
                </text>
              </g>
            ))}
            {xTicks.map((t) => (
              <text key={t} className="tick" x={x(t)} y={height - 6} textAnchor="middle">
                {formatTime(new Date(t).toISOString(), timeZone)}
              </text>
            ))}

            {overlayPath && (
              <path
                d={overlayPath}
                fill="none"
                stroke={overlay!.series.color}
                strokeWidth={1.5}
                strokeDasharray="5 4"
                strokeLinejoin="round"
              />
            )}

            {paths.map(({ series: s, d }) => (
              <path key={s.key} d={d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" />
            ))}

            {last &&
              endLabels.map(({ series: s, y: ly }) => (
                <text key={s.key} className="direct-label" x={x(last.t) + 8} y={ly} dy="0.32em">
                  {s.label}
                </text>
              ))}

            {hovered && (
              <g pointerEvents="none">
                <line className="crosshair" x1={tooltipLeft} x2={tooltipLeft} y1={MARGIN.top} y2={MARGIN.top + innerH} />
                {series.map((s) => (
                  <circle
                    key={s.key}
                    className="hover-dot"
                    cx={tooltipLeft}
                    cy={y(hovered.values[s.key] ?? 0)}
                    r={4}
                    fill={s.color}
                  />
                ))}
              </g>
            )}

            <rect
              className="hit-area"
              x={MARGIN.left}
              y={MARGIN.top}
              width={innerW}
              height={innerH}
              onPointerMove={onPointerMove}
              onPointerLeave={() => setHover(null)}
            />
          </svg>
        )}

        {hovered && (
          <div
            className="tooltip"
            style={{
              left: tooltipLeft,
              top: MARGIN.top,
              transform: tooltipLeft > width / 2 ? "translateX(calc(-100% - 12px))" : "translateX(12px)",
            }}
          >
            <div className="tooltip-title">{formatTime(new Date(hovered.t).toISOString(), timeZone)} Uhr</div>
            {series.map((s) => (
              <div key={s.key} className="tooltip-row">
                <span className="legend-swatch" style={{ background: s.color }} />
                <span>{s.label}</span>
                <span className="tooltip-value">{formatValue(hovered.values[s.key] ?? 0)}</span>
              </div>
            ))}
            {overlay && hoveredOverlay && (
              <div className="tooltip-row">
                <span className="legend-swatch legend-swatch-dashed" style={{ borderColor: overlay.series.color }} />
                <span>{overlay.series.label}</span>
                <span className="tooltip-value">{formatValue(hoveredOverlay.value)}</span>
              </div>
            )}
          </div>
        )}
      </div>

      <DataTable points={points} series={series} timeZone={timeZone} formatValue={formatValue} />
    </figure>
  );
}

/** Tabellenansicht als zugängliche Alternative zum Diagramm (stündliche Werte) */
function DataTable({
  points,
  series,
  timeZone,
  formatValue,
}: Pick<Props, "points" | "series" | "timeZone" | "formatValue">) {
  const hourly = points.filter((p) => new Date(p.t).getUTCMinutes() === 0);
  if (hourly.length === 0) return null;
  return (
    <details className="data-table">
      <summary>Tabelle anzeigen</summary>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Uhrzeit</th>
              {series.map((s) => (
                <th key={s.key} scope="col">
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {hourly.map((p) => (
              <tr key={p.t}>
                <th scope="row">{formatTime(new Date(p.t).toISOString(), timeZone)}</th>
                {series.map((s) => (
                  <td key={s.key}>{formatValue(p.values[s.key] ?? 0)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
