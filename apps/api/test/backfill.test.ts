import type { EnergySnapshot } from "@hef/energy-domain";
import { describe, expect, it } from "vitest";
import { MemoryEnergyRepository } from "../src/db/repository.js";
import { EnergyBackfiller, findGaps, subtractIntervals } from "../src/energy/backfill.js";
import type { EnergyProvider } from "../src/energy/provider.js";
import { silentLogger, snapshot } from "./helpers.js";

const MIN = 60_000;
const NOW = new Date("2026-11-01T12:00:00Z");

const options = { days: 1, retentionDays: 30, gapSeconds: 15 * 60, settleSeconds: 10 * 60, everyMinutes: 60, stepMinutes: 5, maxHoursPerStep: 48, logger: silentLogger, now: () => NOW };

/** Liefert für jede angefragte Lücke 5-Minuten-Werte und merkt sich die Anfragen */
function historyProvider() {
  const requests: { start: Date; end: Date }[] = [];
  const provider: EnergyProvider = {
    source: "sungrow-cloud",
    async getCurrentSnapshot() {
      throw new Error("nicht benötigt");
    },
    async getHistory(start, end) {
      requests.push({ start, end });
      const result: EnergySnapshot[] = [];
      for (let t = Math.ceil(start.getTime() / (5 * MIN)) * 5 * MIN; t <= end.getTime(); t += 5 * MIN) {
        result.push(snapshot({ timestamp: new Date(t).toISOString(), source: "sungrow-cloud" }));
      }
      return result;
    },
  };
  return { provider, requests };
}

describe("findGaps", () => {
  it("findet Lücken zwischen Messwerten und an den Rändern", () => {
    const gaps = findGaps([10 * MIN, 15 * MIN, 60 * MIN], 0, 70 * MIN, 15 * MIN);
    expect(gaps.map((g) => [g.start.getTime() / MIN, g.end.getTime() / MIN])).toEqual([[15, 60]]);
    expect(findGaps([], 0, 60 * MIN, 15 * MIN)).toHaveLength(1);
  });
});

describe("EnergyBackfiller", () => {
  it("füllt Lücken aus dem Verlauf und lässt vorhandene Werte stehen", async () => {
    const repo = new MemoryEnergyRepository();
    const start = NOW.getTime() - 86_400_000;
    // Lückenlos bis auf 08:00–10:00 UTC; Demo-Werte zählen nicht als Abdeckung
    const stored: EnergySnapshot[] = [];
    for (let t = start; t <= NOW.getTime() - 10 * MIN; t += 5 * MIN) {
      const inGap = t > Date.parse("2026-11-01T08:00:00Z") && t < Date.parse("2026-11-01T10:00:00Z");
      stored.push(snapshot({ timestamp: new Date(t).toISOString(), source: inGap ? "demo" : "sungrow-cloud" }));
    }
    await repo.insertMany(stored);
    const { provider, requests } = historyProvider();

    const inserted = await new EnergyBackfiller(provider, repo, options).run();

    expect(requests).toEqual([{ start: new Date("2026-11-01T08:00:00Z"), end: new Date("2026-11-01T10:00:00Z") }]);
    // 08:00 und 10:00 sind schon gespeichert und werden nicht doppelt angelegt
    expect(inserted).toBe(25);
    const filled = await repo.range(new Date("2026-11-01T08:00:00Z"), new Date("2026-11-01T10:00:01Z"));
    expect(filled.filter((s) => s.source === "sungrow-cloud")).toHaveLength(25);
  });

  it("macht nichts ohne Verlauf der Quelle", async () => {
    const provider: EnergyProvider = { source: "demo", getCurrentSnapshot: async () => snapshot() };
    const backfiller = new EnergyBackfiller(provider, new MemoryEnergyRepository(), options);
    expect(backfiller.supported).toBe(false);
    expect(await backfiller.run()).toBe(0);
  });

  it("schluckt fehlende Anmeldung ohne Warnung", async () => {
    const warnings: unknown[] = [];
    const provider: EnergyProvider = {
      source: "sungrow-cloud",
      getCurrentSnapshot: async () => snapshot(),
      getHistory: async () => {
        throw Object.assign(new Error("nicht autorisiert"), { code: "auth_required" });
      },
    };
    const logger = { ...silentLogger, warn: (...args: unknown[]) => warnings.push(args) };
    expect(await new EnergyBackfiller(provider, new MemoryEnergyRepository(), { ...options, logger }).run()).toBe(0);
    expect(warnings).toHaveLength(0);
  });
});

describe("Nachladen auf Anfrage", () => {
  it("lädt einen angefragten Zeitraum, aber nicht vor der Aufbewahrungsfrist", async () => {
    const { provider, requests } = historyProvider();
    const backfiller = new EnergyBackfiller(provider, new MemoryEnergyRepository(), { ...options, retentionDays: 2 });
    await backfiller.request(new Date("2026-10-01T00:00:00Z"), new Date("2026-10-31T00:00:00Z"));
    // 12 h Lücke in 2-h-Stücken, jüngstes zuerst
    expect(requests).toHaveLength(6);
    expect(requests[0]).toEqual({ start: new Date("2026-10-30T22:00:00Z"), end: new Date("2026-10-31T00:00:00Z") });
    expect(requests.at(-1)).toEqual({ start: new Date("2026-10-30T12:00:00Z"), end: new Date("2026-10-30T14:00:00Z") });
  });

  it("fragt Zeiträume ohne Daten der Quelle nicht erneut an", async () => {
    const requests: Date[] = [];
    const provider: EnergyProvider = {
      source: "sungrow-cloud",
      getCurrentSnapshot: async () => snapshot(),
      getHistory: async (start) => {
        requests.push(start);
        return [];
      },
    };
    let now = NOW.getTime();
    const backfiller = new EnergyBackfiller(provider, new MemoryEnergyRepository(), { ...options, days: 3, now: () => new Date(now) });
    // Bei der Abfrage schon alt: nie wieder
    const old = { start: new Date("2026-10-30T00:00:00Z"), end: new Date("2026-10-30T04:00:00Z") };
    // Jung (z. B. Datenlogger offline): nach einer Stunde erneut
    const recent = { start: new Date("2026-11-01T06:00:00Z"), end: new Date("2026-11-01T08:00:00Z") };
    await backfiller.request(old.start, old.end);
    expect(requests).toHaveLength(2);
    now += 10 * 60_000;
    await backfiller.request(old.start, old.end);
    expect(requests).toHaveLength(2);
    expect(backfiller.busy).toBe(false);

    now += 10 * 60_000;
    await backfiller.request(recent.start, recent.end);
    expect(requests).toHaveLength(3);
    now += 30 * 60_000;
    await backfiller.request(recent.start, recent.end);
    expect(requests).toHaveLength(3);
    now += 40 * 60_000;
    await backfiller.request(recent.start, recent.end);
    expect(requests).toHaveLength(4);
  });

  it("zieht erledigte Abschnitte von Lücken ab", () => {
    const at = (h: number) => new Date(Date.UTC(2026, 9, 30, h));
    const rest = subtractIntervals([{ start: at(0), end: at(10) }], [{ start: at(2), end: at(4) }], 15 * MIN);
    expect(rest).toEqual([
      { start: at(0), end: at(2) },
      { start: at(4), end: at(10) },
    ]);
  });
});

describe("Robustheit", () => {
  it("speichert jedes Stück sofort, auch wenn ein späteres am Limit scheitert", async () => {
    const repo = new MemoryEnergyRepository();
    let calls = 0;
    const provider: EnergyProvider = {
      source: "sungrow-cloud",
      getCurrentSnapshot: async () => snapshot(),
      getHistory: async (start) => {
        calls += 1;
        if (calls === 2) throw new Error("er_hour_call_api_times_upper_limit");
        return [snapshot({ timestamp: start.toISOString(), source: "sungrow-cloud" })];
      },
    };
    await new EnergyBackfiller(provider, repo, options).request(new Date("2026-11-01T04:00:00Z"), new Date("2026-11-01T10:00:00Z"));
    expect(await repo.range(new Date("2026-11-01T00:00:00Z"), new Date("2026-11-01T12:00:00Z"))).toHaveLength(1);
  });

  it("überlebt einen Ausfall der Datenbank", async () => {
    const repo = new MemoryEnergyRepository();
    repo.range = async () => {
      throw new Error("connection refused");
    };
    const { provider } = historyProvider();
    await expect(new EnergyBackfiller(provider, repo, options).run()).resolves.toBe(0);
  });
});

describe("Schonung des Abfragelimits", () => {
  it("lädt pro Portion höchstens maxHoursPerStep Stunden, jüngste zuerst, und bleibt vorgemerkt", async () => {
    const { provider, requests } = historyProvider();
    const backfiller = new EnergyBackfiller(provider, new MemoryEnergyRepository(), { ...options, days: 3, maxHoursPerStep: 6 });
    await backfiller.request(new Date("2026-11-01T00:00:00Z"), new Date("2026-11-01T11:50:00Z"));
    expect(requests).toEqual([
      { start: new Date("2026-11-01T09:50:00Z"), end: new Date("2026-11-01T11:50:00Z") },
      { start: new Date("2026-11-01T07:50:00Z"), end: new Date("2026-11-01T09:50:00Z") },
      { start: new Date("2026-11-01T05:50:00Z"), end: new Date("2026-11-01T07:50:00Z") },
    ]);
    expect(backfiller.busy).toBe(true);
    // Sofortige weitere Anfrage löst keine neue Portion aus
    await backfiller.request(new Date("2026-11-01T00:00:00Z"), new Date("2026-11-01T11:50:00Z"));
    expect(requests).toHaveLength(3);
  });

  it("pausiert bis zur nächsten vollen Stunde, wenn die Quelle ihr Limit meldet", async () => {
    let now = Date.parse("2026-11-01T11:20:00Z");
    let calls = 0;
    const provider: EnergyProvider = {
      source: "sungrow-cloud",
      getCurrentSnapshot: async () => snapshot(),
      getHistory: async () => {
        calls += 1;
        throw new Error("er_hour_call_api_times_upper_limit");
      },
    };
    const backfiller = new EnergyBackfiller(provider, new MemoryEnergyRepository(), { ...options, now: () => new Date(now) });
    await backfiller.request(new Date("2026-11-01T00:00:00Z"), new Date("2026-11-01T10:00:00Z"));
    now += 10 * 60_000;
    await backfiller.request(new Date("2026-11-01T00:00:00Z"), new Date("2026-11-01T10:00:00Z"));
    expect(calls).toBe(1);
    expect(backfiller.busy).toBe(true);
    now = Date.parse("2026-11-01T12:03:00Z");
    await backfiller.request(new Date("2026-11-01T00:00:00Z"), new Date("2026-11-01T10:00:00Z"));
    expect(calls).toBe(2);
  });
});
