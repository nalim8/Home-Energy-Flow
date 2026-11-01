import type { EnergySnapshot } from "@hef/energy-domain";
import { describe, expect, it, vi } from "vitest";
import { MemoryEnergyRepository } from "../src/db/repository.js";
import { EnergyPoller } from "../src/energy/poller.js";
import type { EnergyProvider } from "../src/energy/provider.js";
import { silentLogger, snapshot } from "./helpers.js";

function providerFrom(...results: (EnergySnapshot | Error)[]): EnergyProvider {
  return {
    source: "demo",
    async getCurrentSnapshot() {
      const next = results.shift();
      if (!next || next instanceof Error) throw next ?? new Error("keine Daten");
      return next;
    },
  };
}

const options = {
  intervalSeconds: 30,
  retentionDays: 30,
  logger: silentLogger,
  now: () => new Date("2026-06-21T10:00:30Z"),
};

describe("EnergyPoller", () => {
  it("speichert gültige Messwerte und meldet Erfolg", async () => {
    const repo = new MemoryEnergyRepository();
    const poller = new EnergyPoller(providerFrom(snapshot()), repo, options);

    expect(await poller.pollOnce()).toBe(true);
    expect(await repo.latest()).toEqual(snapshot());
    expect(poller.getStatus()).toMatchObject({ lastError: null, consecutiveFailures: 0 });
  });

  it("speichert bei Fehlern nichts und zählt Fehlversuche", async () => {
    const repo = new MemoryEnergyRepository();
    const poller = new EnergyPoller(
      providerFrom(snapshot(), new Error("Token abgelaufen"), new Error("Timeout")),
      repo,
      options,
    );

    await poller.pollOnce();
    await poller.pollOnce();
    await poller.pollOnce();

    expect((await repo.range(new Date(0), new Date(8.64e15))).length).toBe(1);
    expect(poller.getStatus()).toMatchObject({ lastError: "Timeout", consecutiveFailures: 2 });
    expect(poller.getStatus().lastSuccessAt).not.toBeNull();
  });

  it("weist ungültige Provider-Daten zurück", async () => {
    const repo = new MemoryEnergyRepository();
    const poller = new EnergyPoller(providerFrom(snapshot({ batterySocPercent: 140 })), repo, options);

    expect(await poller.pollOnce()).toBe(false);
    expect(await repo.latest()).toBeNull();
    expect(poller.getStatus().lastError).toContain("batterySocPercent");
  });

  it("löscht Messwerte außerhalb der Aufbewahrungsfrist", async () => {
    const repo = new MemoryEnergyRepository();
    await repo.insertMany([snapshot({ timestamp: "2026-05-01T00:00:00Z" })]);
    const poller = new EnergyPoller(providerFrom(snapshot()), repo, {
      ...options,
      now: () => new Date("2026-06-21T10:00:00Z"),
    });

    await poller.pollOnce();
    expect((await repo.range(new Date(0), new Date(8.64e15))).map((s) => s.timestamp)).toEqual([
      snapshot().timestamp,
    ]);
  });

  it("startet bei pollNow während eines Abrufs keine zweite Schleife", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      let release!: () => void;
      const provider: EnergyProvider = {
        source: "demo",
        getCurrentSnapshot() {
          calls += 1;
          if (calls === 1) return new Promise((resolve) => (release = () => resolve(snapshot())));
          return Promise.resolve(snapshot());
        },
      };
      const poller = new EnergyPoller(provider, new MemoryEnergyRepository(), options);
      poller.start();
      poller.pollNow();
      release();
      await vi.advanceTimersByTimeAsync(0);
      // Der vorgezogene Abruf folgt direkt auf den laufenden
      expect(calls).toBe(2);
      await vi.advanceTimersByTimeAsync(options.intervalSeconds * 1000);
      // Danach genau eine Schleife: ein Abruf pro Intervall
      expect(calls).toBe(3);
      poller.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
