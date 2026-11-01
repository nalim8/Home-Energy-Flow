import type { EnergyFlows } from "@hef/energy-domain";
import { formatPower, formatRatio } from "../format";

const SEGMENTS = [
  { key: "batteryToHouse", label: "Speicher", color: "var(--c-battery)" },
  { key: "pvToHouse", label: "PV", color: "var(--c-pv)" },
  { key: "gridToHouse", label: "Netz", color: "var(--c-grid)" },
] as const;

/**
 * Woher kommt der Strom, den das Haus gerade verbraucht? Die Aufteilung ist
 * eine Modellannahme (siehe computeFlows), keine eigene Messung.
 */
export function HouseSupply({ flows }: { flows: EnergyFlows }) {
  const total = SEGMENTS.reduce((sum, s) => sum + flows[s.key], 0);
  if (total <= 0) return null;
  const parts = SEGMENTS.map((s) => ({ ...s, watts: flows[s.key], share: flows[s.key] / total })).filter(
    (p) => p.watts > 0,
  );

  return (
    <section className="house-supply" aria-labelledby="house-supply-title">
      <h3 id="house-supply-title" className="small-title">
        Versorgung des Hauses
      </h3>
      <div className="supply-bar" aria-hidden="true">
        {parts.map((p) => (
          <span key={p.key} style={{ flexGrow: p.share, background: p.color }} />
        ))}
      </div>
      <ul className="supply-legend">
        {parts.map((p) => (
          <li key={p.key}>
            <span className="legend-swatch" style={{ background: p.color }} />
            <span>{p.label}</span>
            <span className="supply-value">
              {formatRatio(p.share)} · {formatPower(p.watts)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
