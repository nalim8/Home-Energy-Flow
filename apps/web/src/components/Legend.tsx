import type { Series } from "./chart-utils";

export function Legend({ series }: { series: readonly Series[] }) {
  return (
    <ul className="legend" aria-hidden="true">
      {series.map((s) => (
        <li key={s.key}>
          <span
            className={s.dashed ? "legend-swatch legend-swatch-dashed" : "legend-swatch"}
            style={s.dashed ? { borderColor: s.color } : { background: s.color }}
          />
          {s.label}
        </li>
      ))}
    </ul>
  );
}
