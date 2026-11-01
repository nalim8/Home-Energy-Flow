import type {
  CurrentEnergyResponse,
  DailyBalancesResponse,
  HistoryResponse,
  MetaResponse,
  PollStatus,
  RangeBalanceResponse,
} from "@hef/energy-domain";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { MemoryEnergyRepository } from "../src/db/repository.js";
import { EnergyService } from "../src/energy/service.js";
import { snapshot, testConfig } from "./helpers.js";

const NOW = new Date("2026-06-21T10:00:30Z");

const meta: MetaResponse = {
  source: "demo",
  timezone: "Europe/Berlin",
  pollIntervalSeconds: 30,
  staleAfterSeconds: 90,
  demo: true,
  retentionDays: 30,
};

const poll: PollStatus = { lastAttemptAt: null, lastSuccessAt: null, lastError: null, lastErrorCode: null, consecutiveFailures: 0 };

describe("REST-API", () => {
  let repository: MemoryEnergyRepository;
  let app: FastifyInstance;

  beforeEach(async () => {
    repository = new MemoryEnergyRepository();
    const service = new EnergyService(repository, {
      timeZone: "Europe/Berlin",
      staleAfterSeconds: 90,
      maxGapSeconds: 900,
      getPollStatus: () => poll,
      now: () => NOW,
    });
    app = await buildApp({ config: testConfig(), service, meta });
  });

  afterEach(() => app.close());

  it("GET /api/health", async () => {
    const res = await app.inject("/api/health");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("meldet fehlende Daten als nicht verfügbar", async () => {
    const body = (await app.inject("/api/energy/current")).json<CurrentEnergyResponse>();
    expect(body.snapshot).toBeNull();
    expect(body.freshness.status).toBe("unavailable");
  });

  it("liefert aktuellen Messwert mit Flüssen und Aktualität", async () => {
    await repository.insertMany([snapshot()]);
    const body = (await app.inject("/api/energy/current")).json<CurrentEnergyResponse>();
    expect(body.snapshot?.pvPowerW).toBe(3200);
    expect(body.flows).toMatchObject({ pvToHouse: 1100, pvToBattery: 1700, pvToGrid: 400 });
    expect(body.freshness).toEqual({ status: "live", ageSeconds: 30 });
  });

  it("markiert alte Messwerte als veraltet", async () => {
    await repository.insertMany([snapshot({ timestamp: "2026-06-21T09:00:00Z" })]);
    const body = (await app.inject("/api/energy/current")).json<CurrentEnergyResponse>();
    expect(body.freshness.status).toBe("stale");
  });

  it("filtert die Historie nach Kalendertag der Anlagen-Zeitzone", async () => {
    await repository.insertMany([
      snapshot({ timestamp: "2026-06-20T21:59:00Z" }), // 23:59 MESZ am Vortag
      snapshot({ timestamp: "2026-06-20T22:01:00Z", pvPowerW: 0, gridPowerW: 1000, gridDirection: "import" }),
      snapshot({ timestamp: "2026-06-20T22:03:00Z", pvPowerW: 0, gridPowerW: 1000, gridDirection: "import" }),
    ]);
    const body = (await app.inject("/api/energy/history?date=2026-06-21&bucketMinutes=5")).json<HistoryResponse>();
    expect(body.points).toHaveLength(1);
    expect(body.points[0]).toMatchObject({ timestamp: "2026-06-20T22:00:00.000Z", gridPowerW: 1000, pvPowerW: 0 });
  });

  it("liefert Tagesbilanzen für mehrere Tage", async () => {
    const body = (await app.inject("/api/energy/balance/daily?days=3")).json<DailyBalancesResponse>();
    expect(body.days.map((d) => d.date)).toEqual(["2026-06-19", "2026-06-20", "2026-06-21"]);
  });

  it("liefert Gesamt- und Tagesbilanzen eines Zeitraums", async () => {
    await repository.insertMany([
      snapshot({ timestamp: "2026-06-20T10:00:00.000Z" }),
      snapshot({ timestamp: "2026-06-20T10:05:00.000Z" }),
    ]);
    const body = (await app.inject("/api/energy/balance/range?from=2026-06-19&to=2026-06-21")).json<RangeBalanceResponse>();
    expect(body.days.map((d) => d.date)).toEqual(["2026-06-19", "2026-06-20", "2026-06-21"]);
    expect(body.total.pvWh).toBeCloseTo(3200 / 12);
    expect(body.backfilling).toBe(false);
  });

  it("weist ungültige Zeiträume ab", async () => {
    expect((await app.inject("/api/energy/balance/range?from=2026-06-21&to=2026-06-19")).statusCode).toBe(400);
    expect((await app.inject("/api/energy/balance/range?from=2025-01-01&to=2026-06-21")).statusCode).toBe(400);
  });

  it("weist ungültige Parameter ab", async () => {
    expect((await app.inject("/api/energy/history?date=21.06.2026")).statusCode).toBe(400);
    expect((await app.inject("/api/energy/balance/daily?days=500")).statusCode).toBe(400);
  });

  it("antwortet mit 404 auf unbekannte API-Pfade", async () => {
    expect((await app.inject("/api/unknown")).statusCode).toBe(404);
  });
});

describe("Quellenfilter", () => {
  it("wertet nur Messwerte der aktiven Quelle aus", async () => {
    const repository = new MemoryEnergyRepository();
    await repository.insertMany([
      snapshot({ timestamp: "2026-06-21T09:00:00.000Z", source: "sungrow-cloud", pvPowerW: 500 }),
      snapshot({ timestamp: "2026-06-21T09:30:00.000Z", source: "demo", pvPowerW: 9000 }),
    ]);
    const service = new EnergyService(repository, {
      timeZone: "Europe/Berlin",
      staleAfterSeconds: 3600,
      maxGapSeconds: 900,
      getPollStatus: () => poll,
      source: "sungrow-cloud",
      now: () => NOW,
    });
    expect((await service.getCurrent()).snapshot?.pvPowerW).toBe(500);
    // Neuere Werte einer anderen Quelle verdecken nicht den letzten Wert der gesuchten
    expect((await repository.latest("sungrow-cloud"))?.pvPowerW).toBe(500);
    expect((await repository.latest("demo"))?.pvPowerW).toBe(9000);
    expect((await service.getDailyBalance("2026-06-21")).balance.sampleCount).toBe(1);
  });
});

describe("Zugriffsschutz", () => {
  let app: FastifyInstance;
  const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

  beforeEach(async () => {
    const service = new EnergyService(new MemoryEnergyRepository(), {
      timeZone: "Europe/Berlin",
      staleAfterSeconds: 90,
      maxGapSeconds: 900,
      getPollStatus: () => poll,
      now: () => NOW,
    });
    app = await buildApp({ config: testConfig({ APP_PASSWORD: "geheim" }), service, meta });
  });

  afterEach(() => app.close());

  it("verlangt das Passwort für API und Login", async () => {
    for (const url of ["/api/meta", "/api/energy/current?x=1", "/auth/sungrow/login"]) {
      const res = await app.inject(url);
      expect(res.statusCode).toBe(401);
      expect(res.headers["www-authenticate"]).toContain("Basic");
    }
    const wrong = await app.inject({ url: "/api/meta", headers: { authorization: basic("x", "falsch") } });
    expect(wrong.statusCode).toBe(401);
  });

  it("lässt mit Passwort und beliebigem Benutzer durch", async () => {
    const res = await app.inject({ url: "/api/meta", headers: { authorization: basic("ich", "geheim") } });
    expect(res.statusCode).toBe(200);
  });

  it("lässt den Healthcheck ohne Anmeldung zu", async () => {
    expect((await app.inject("/api/health")).statusCode).toBe(200);
  });
});
