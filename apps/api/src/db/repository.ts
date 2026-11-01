import type { EnergySnapshot } from "@hef/energy-domain";

type Source = EnergySnapshot["source"];

export interface EnergyRepository {
  /** Speichert Messwerte; doppelte Zeitstempel je Quelle werden ignoriert. */
  insertMany(snapshots: readonly EnergySnapshot[]): Promise<void>;
  /** Jüngster Messwert, optional nur einer Quelle */
  latest(source?: Source): Promise<EnergySnapshot | null>;
  /** Messwerte im halboffenen Intervall [start, end), aufsteigend sortiert, optional nur einer Quelle */
  range(start: Date, end: Date, source?: Source): Promise<EnergySnapshot[]>;
  /** Löscht Messwerte vor `before` und gibt die Anzahl zurück */
  pruneBefore(before: Date): Promise<number>;
  close(): Promise<void>;
}

/** Hält Messwerte im Arbeitsspeicher; für Demo-Betrieb und Tests. */
export class MemoryEnergyRepository implements EnergyRepository {
  private readonly items: EnergySnapshot[] = [];
  private readonly keys = new Set<string>();

  async insertMany(snapshots: readonly EnergySnapshot[]): Promise<void> {
    let needsSort = false;
    for (const s of snapshots) {
      const key = `${s.source}|${Date.parse(s.timestamp)}`;
      if (this.keys.has(key)) continue;
      this.keys.add(key);
      const last = this.items.at(-1);
      if (last && Date.parse(last.timestamp) > Date.parse(s.timestamp)) needsSort = true;
      this.items.push(s);
    }
    if (needsSort) this.items.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  }

  async latest(source?: Source): Promise<EnergySnapshot | null> {
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (!source || this.items[i]!.source === source) return this.items[i]!;
    }
    return null;
  }

  async range(start: Date, end: Date, source?: Source): Promise<EnergySnapshot[]> {
    const from = lowerBound(this.items, start.getTime());
    const to = lowerBound(this.items, end.getTime());
    const items = this.items.slice(from, to);
    return source ? items.filter((s) => s.source === source) : items;
  }

  async pruneBefore(before: Date): Promise<number> {
    const count = lowerBound(this.items, before.getTime());
    for (const s of this.items.splice(0, count)) this.keys.delete(`${s.source}|${Date.parse(s.timestamp)}`);
    return count;
  }

  async close(): Promise<void> {}
}

function lowerBound(items: readonly EnergySnapshot[], ms: number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (Date.parse(items[mid]!.timestamp) < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
