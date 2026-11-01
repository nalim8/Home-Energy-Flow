import type { EnergyBalance } from "@hef/energy-domain";
import { useState } from "react";
import { formatEnergy, formatRatio } from "../format";
import { useElementWidth } from "../hooks";
import { niceTicks, roundedBarPath, type Series } from "./chart-utils";
import { Legend } from "./Legend";

const SERIES: Series[] = [
  { key: "pvWh", label: "Erzeugung", color: "var(--c-pv)" },
  { key: "householdWh", label: "Verbrauch", color: "var(--c-house)" },
];

const MARGIN = { top: 22, right: 8, bottom: 26, left: 52 };
const HEIGHT = 220;
/** Abstand zwischen benachbarten Balken einer Gruppe */
const BAR_GAP = 2;
/** Platzbedarf einer Achsenbeschriftung; bei vielen Balken wird nur jede n-te beschriftet */
const LABEL_WIDTH = 52;

export interface PeriodItem {
  /** Datum (YYYY-MM-DD) oder Monat (YYYY-MM) */
  key: string;
  /** Kurze Achsenbeschriftung */
  label: string;
  /** Beschriftung in Tooltip und Tabelle */
  title: string;
  balance: EnergyBalance;
}

interface Props {
  items: PeriodItem[];
  caption: string;
  selectedKey?: string;
  onSelect: (key: string) => void;
}

/** Erzeugung und Verbrauch je Tag oder Monat; ein Klick wählt den Balken aus. */
export function PeriodChart({ items, caption, selectedKey, onSelect }: Props) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const innerW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const max = Math.max(1000, ...items.flatMap((d) => [d.balance.pvWh, d.balance.householdWh]));
  const ticks = niceTicks(0, max, 4);
  const yMax = ticks.at(-1)!;
  const y = (v: number) => MARGIN.top + (1 - v / yMax) * innerH;

  const slot = innerW / items.length;
  const barW = Math.max(1, Math.min(28, (slot * 0.6 - BAR_GAP) / 2));
  const groupW = barW * 2 + BAR_GAP;
  const labelEvery = Math.max(1, Math.ceil(LABEL_WIDTH / slot));

  const hovered = hover !== null ? items[hover] : undefined;

  return (
    <figure className="chart">
      <figcaption className="chart-title">{caption}</figcaption>
      <Legend series={SERIES} />
      <div ref={ref} className="chart-canvas" style={{ height: HEIGHT }}>
        {width > 0 && (
          <svg width={width} height={HEIGHT} role="img" aria-label={`${caption}, Details in der Tabelle`}>
            {ticks.map((v) => (
              <g key={v}>
                <line className={v === 0 ? "axis-zero" : "grid-line"} x1={MARGIN.left} x2={MARGIN.left + innerW} y1={y(v)} y2={y(v)} />
                <text className="tick" x={MARGIN.left - 8} y={y(v)} dy="0.32em" textAnchor="end">
                  {(v / 1000).toLocaleString("de-DE")} kWh
                </text>
              </g>
            ))}

            {items.map((item, i) => {
              const cx = MARGIN.left + slot * (i + 0.5);
              const selected = item.key === selectedKey;
              // Vom Ende her beschriften, damit der jüngste Balken immer eine Beschriftung hat
              const labelled = selected || (items.length - 1 - i) % labelEvery === 0;
              return (
                <g key={item.key}>
                  {selected && (
                    <rect className="selected-band" x={cx - slot / 2 + 1} y={MARGIN.top - 18} width={Math.max(2, slot - 2)} height={innerH + 18} rx={6} />
                  )}
                  {SERIES.map((s, j) => {
                    const value = item.balance[s.key as "pvWh" | "householdWh"];
                    const bx = cx - groupW / 2 + j * (barW + BAR_GAP);
                    return <path key={s.key} d={roundedBarPath(bx, y(value), barW, y(0) - y(value))} fill={s.color} />;
                  })}
                  {selected && (
                    <text className="direct-label" x={cx} y={MARGIN.top - 6} textAnchor="middle">
                      {formatEnergy(item.balance.pvWh)}
                    </text>
                  )}
                  {labelled && (
                    <text className={selected ? "tick tick-strong" : "tick"} x={cx} y={HEIGHT - 6} textAnchor="middle">
                      {item.label}
                    </text>
                  )}
                  <rect
                    className="hit-area clickable"
                    x={cx - slot / 2}
                    y={MARGIN.top}
                    width={slot}
                    height={innerH + MARGIN.bottom}
                    onPointerEnter={() => setHover(i)}
                    onPointerLeave={() => setHover(null)}
                    onClick={() => onSelect(item.key)}
                  />
                </g>
              );
            })}
          </svg>
        )}

        {hovered && hover !== null && (
          <div
            className="tooltip"
            style={{
              left: MARGIN.left + slot * (hover + 0.5),
              top: MARGIN.top,
              transform: hover >= items.length / 2 ? "translateX(calc(-100% - 16px))" : "translateX(16px)",
            }}
          >
            <div className="tooltip-title">{hovered.title}</div>
            {SERIES.map((s) => (
              <div key={s.key} className="tooltip-row">
                <span className="legend-swatch" style={{ background: s.color }} />
                <span>{s.label}</span>
                <span className="tooltip-value">{formatEnergy(hovered.balance[s.key as "pvWh" | "householdWh"])}</span>
              </div>
            ))}
            {hovered.balance.autarkyRate !== null && (
              <div className="tooltip-row tooltip-row-plain">
                <span>Autarkie</span>
                <span className="tooltip-value">{formatRatio(hovered.balance.autarkyRate)}</span>
              </div>
            )}
          </div>
        )}
      </div>

      <details className="data-table">
        <summary>Tabelle anzeigen</summary>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Zeitraum</th>
                <th scope="col">Erzeugung</th>
                <th scope="col">Verbrauch</th>
                <th scope="col">Netzbezug</th>
                <th scope="col">Einspeisung</th>
                <th scope="col">Autarkie</th>
              </tr>
            </thead>
            <tbody>
              {items.map(({ key, title, balance }) => (
                <tr key={key}>
                  <th scope="row">{title}</th>
                  <td>{formatEnergy(balance.pvWh)}</td>
                  <td>{formatEnergy(balance.householdWh)}</td>
                  <td>{formatEnergy(balance.gridImportWh)}</td>
                  <td>{formatEnergy(balance.gridExportWh)}</td>
                  <td>{balance.autarkyRate === null ? "–" : formatRatio(balance.autarkyRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
