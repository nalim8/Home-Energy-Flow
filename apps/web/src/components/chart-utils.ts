export interface Series {
  key: string;
  label: string;
  /** CSS-Farbe, i. d. R. eine Variable wie var(--c-pv) */
  color: string;
  /** Gestrichelt, z. B. für Prognosen */
  dashed?: boolean;
}

/** Gut lesbare Achsenwerte (1, 2, 2,5, 5 × 10ⁿ) für den Bereich [min, max] */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (min === max) max = min + 1;
  const rawStep = (max - min) / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * magnitude >= rawStep) ?? 10) * magnitude;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Math.round(v / step) * step);
  return ticks;
}

/** Verschiebt Beschriftungen vertikal, bis sie mindestens `gap` px Abstand haben. */
export function spreadLabels<T extends { y: number }>(labels: T[], gap: number, minY: number, maxY: number): T[] {
  const sorted = [...labels].sort((a, b) => a.y - b.y);
  for (let i = 1; i < sorted.length; i++) {
    sorted[i]!.y = Math.max(sorted[i]!.y, sorted[i - 1]!.y + gap);
  }
  const overflow = (sorted.at(-1)?.y ?? 0) - maxY;
  if (overflow > 0) for (const l of sorted) l.y -= overflow;
  for (const l of sorted) l.y = Math.max(minY, l.y);
  return sorted;
}

/** Pfad mit oben abgerundeten Ecken für Balken, die an der Grundlinie stehen */
export function roundedBarPath(x: number, y: number, width: number, height: number, radius = 4): string {
  if (height <= 0) return "";
  const r = Math.min(radius, width / 2, height);
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
}
