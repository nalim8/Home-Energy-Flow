import {
  assessFreshness,
  computeBalance,
  computeFlows,
  signedGridPower,
  sumBalances,
  type CurrentEnergyResponse,
  type DailyBalanceResponse,
  type DailyBalancesResponse,
  type EnergySnapshot,
  type HistoryPoint,
  type HistoryResponse,
  type PollStatus,
  type RangeBalanceResponse,
} from "@hef/energy-domain";
import type { EnergyRepository } from "../db/repository.js";
import { addDays, dayRange, isoDateInZone } from "../lib/time.js";

export interface EnergyServiceOptions {
  timeZone: string;
  staleAfterSeconds: number;
  /** Lücken ab dieser Länge gelten in der Tagesbilanz als fehlende Daten */
  maxGapSeconds: number;
  getPollStatus: () => PollStatus;
  /** Nur Messwerte dieser Quelle auswerten, z. B. damit alte Demo-Daten echte Werte nicht verfälschen */
  source?: EnergySnapshot["source"];
  now?: () => Date;
}

export class EnergyService {
  private readonly now: () => Date;

  constructor(
    private readonly repository: EnergyRepository,
    private readonly options: EnergyServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  today(): string {
    return isoDateInZone(this.now(), this.options.timeZone);
  }

  async getCurrent(): Promise<CurrentEnergyResponse> {
    const snapshot = await this.repository.latest(this.options.source);
    return {
      snapshot,
      flows: snapshot ? computeFlows(snapshot) : null,
      freshness: assessFreshness(snapshot?.timestamp ?? null, this.now(), this.options.staleAfterSeconds),
      poll: this.options.getPollStatus(),
    };
  }

  async getHistory(date: string, bucketMinutes: number): Promise<HistoryResponse> {
    const { start, end } = dayRange(date, this.options.timeZone);
    const samples = await this.repository.range(start, end, this.options.source);
    return {
      date,
      timezone: this.options.timeZone,
      start: start.toISOString(),
      end: end.toISOString(),
      bucketMinutes,
      points: downsample(samples, bucketMinutes),
    };
  }

  async getDailyBalance(date: string): Promise<DailyBalanceResponse> {
    const { start, end } = dayRange(date, this.options.timeZone);
    const samples = await this.repository.range(start, end, this.options.source);
    return {
      date,
      timezone: this.options.timeZone,
      balance: computeBalance(samples, { maxGapSeconds: this.options.maxGapSeconds }),
    };
  }

  /** Tagesbilanzen der letzten `days` Tage einschließlich heute */
  async getDailyBalances(days: number): Promise<DailyBalancesResponse> {
    const today = this.today();
    return { timezone: this.options.timeZone, days: await this.balancesByDay(addDays(today, 1 - days), today) };
  }

  /** Gesamtbilanz und Tagesbilanzen der Kalendertage from bis to (jeweils einschließlich) */
  async getRangeBalance(from: string, to: string): Promise<Omit<RangeBalanceResponse, "backfilling">> {
    const days = await this.balancesByDay(from, to);
    return { from, to, timezone: this.options.timeZone, total: sumBalances(days.map((d) => d.balance)), days };
  }

  private async balancesByDay(from: string, to: string) {
    const dates: string[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);
    const { start } = dayRange(from, this.options.timeZone);
    const { end } = dayRange(to, this.options.timeZone);
    const samples = await this.repository.range(start, end, this.options.source);

    const byDate = new Map<string, EnergySnapshot[]>(dates.map((d) => [d, []]));
    for (const s of samples) byDate.get(isoDateInZone(new Date(s.timestamp), this.options.timeZone))?.push(s);

    return dates.map((date) => ({
      date,
      balance: computeBalance(byDate.get(date)!, { maxGapSeconds: this.options.maxGapSeconds }),
    }));
  }
}

/** Mittelt Messwerte in festen Zeitfenstern; leere Fenster entfallen. */
export function downsample(samples: readonly EnergySnapshot[], bucketMinutes: number): HistoryPoint[] {
  const bucketMs = bucketMinutes * 60_000;
  const buckets = new Map<number, { sum: Omit<HistoryPoint, "timestamp">; count: number }>();

  for (const s of samples) {
    const key = Math.floor(Date.parse(s.timestamp) / bucketMs) * bucketMs;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        sum: { pvPowerW: 0, householdPowerW: 0, batteryPowerW: 0, batterySocPercent: 0, gridPowerW: 0 },
        count: 0,
      };
      buckets.set(key, bucket);
    }
    bucket.sum.pvPowerW += s.pvPowerW;
    bucket.sum.householdPowerW += s.householdPowerW;
    bucket.sum.batteryPowerW += s.batteryPowerW;
    bucket.sum.batterySocPercent += s.batterySocPercent;
    bucket.sum.gridPowerW += signedGridPower(s);
    bucket.count += 1;
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([key, { sum, count }]) => ({
      timestamp: new Date(key).toISOString(),
      pvPowerW: Math.round(sum.pvPowerW / count),
      householdPowerW: Math.round(sum.householdPowerW / count),
      batteryPowerW: Math.round(sum.batteryPowerW / count),
      batterySocPercent: Math.round((sum.batterySocPercent / count) * 10) / 10,
      gridPowerW: Math.round(sum.gridPowerW / count),
    }));
}
