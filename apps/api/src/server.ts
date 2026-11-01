import type { MetaResponse } from "@hef/energy-domain";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { migrate } from "./db/migrator.js";
import { PostgresEnergyRepository } from "./db/postgres-repository.js";
import { MemoryEnergyRepository, type EnergyRepository } from "./db/repository.js";
import { DEFAULT_PLANT, DemoEnergyProvider } from "./energy/demo-provider.js";
import { EnergyBackfiller } from "./energy/backfill.js";
import { EnergyPoller } from "./energy/poller.js";
import type { EnergyProvider } from "./energy/provider.js";
import { EnergyService } from "./energy/service.js";
import { SungrowCloudProvider } from "./energy/sungrow-cloud-provider.js";
import { loadTls } from "./lib/tls.js";
import { WeatherService, type Location } from "./weather/open-meteo.js";

const config = loadConfig();

/** Geografische Mitte Deutschlands (bei Kassel), nur für den Demo-Modus */
const DEMO_LOCATION: Location = { latitude: 51.16, longitude: 10.45 };

let repository: EnergyRepository;
if (config.DATABASE_URL) {
  await migrate(config.DATABASE_URL);
  repository = PostgresEnergyRepository.connect(config.DATABASE_URL);
} else {
  repository = new MemoryEnergyRepository();
}

let provider: EnergyProvider;
let sungrow: SungrowCloudProvider | undefined;
if (config.ENERGY_PROVIDER === "sungrow-cloud") {
  sungrow = new SungrowCloudProvider(config);
  provider = sungrow;
} else {
  const demo = new DemoEnergyProvider(config.APP_TIMEZONE);
  await backfillDemo(demo, repository, config.DEMO_BACKFILL_DAYS);
  provider = demo;
}

const service = new EnergyService(repository, {
  timeZone: config.APP_TIMEZONE,
  staleAfterSeconds: config.STALE_AFTER_SECONDS,
  maxGapSeconds: Math.max(15 * 60, config.POLL_INTERVAL_SECONDS * 5),
  source: provider.source,
  // Wird erst bei Anfragen aufgerufen, nachdem der Poller existiert
  getPollStatus: () => poller.getStatus(),
});

const meta: MetaResponse = {
  source: provider.source,
  timezone: config.APP_TIMEZONE,
  pollIntervalSeconds: config.POLL_INTERVAL_SECONDS,
  staleAfterSeconds: config.STALE_AFTER_SECONDS,
  demo: provider.source === "demo",
  retentionDays: config.RETENTION_DAYS,
};

const isDemo = provider.source === "demo";
// Im Demo-Modus Wetter für die Mitte Deutschlands, damit die Vorhersage ohne eigene Anlage sichtbar ist
let plantLocation: Location | null =
  config.WEATHER_LATITUDE !== undefined && config.WEATHER_LONGITUDE !== undefined
    ? { latitude: config.WEATHER_LATITUDE, longitude: config.WEATHER_LONGITUDE }
    : isDemo
      ? DEMO_LOCATION
      : null;
const pvPeakKw = config.PV_PEAK_KW ?? (isDemo ? DEFAULT_PLANT.pvPeakW / 1000 : undefined);
const weather = config.WEATHER_ENABLED
  ? new WeatherService({
      timeZone: config.APP_TIMEZONE,
      locate: async () => {
        // Der Standort ändert sich nicht; einmal gefunden, kostet er keine Sungrow-Abfrage mehr
        if (!plantLocation && sungrow) {
          plantLocation = await sungrow.location().catch((error: unknown) => {
            app.log.warn({ err: error }, "Standort der Anlage nicht abrufbar");
            return null;
          });
        }
        return plantLocation;
      },
      pv: pvPeakKw
        ? {
            peakKw: pvPeakKw,
            tiltDeg: config.PV_TILT_DEG,
            azimuthDeg: config.PV_AZIMUTH_DEG,
            performanceRatio: config.PV_PERFORMANCE_RATIO,
          }
        : null,
    })
  : undefined;

const https = config.HTTPS
  ? await loadTls({ certFile: config.TLS_CERT_FILE, keyFile: config.TLS_KEY_FILE, selfSignedDir: config.TLS_DIR })
  : undefined;
const app = await buildApp(
  // Sofort neu abrufen, statt bis zu einem Intervall mit veraltetem auth_required-Status zu warten
  {
    config,
    service,
    meta,
    sungrow: sungrow?.client,
    weather,
    backfill: { request: (start, end) => backfiller.request(start, end), get busy() { return backfiller.busy; } },
    onSungrowAuthorized: () => {
      poller.pollNow();
      void backfiller.run();
    },
  },
  { https },
);
const poller = new EnergyPoller(provider, repository, {
  intervalSeconds: config.POLL_INTERVAL_SECONDS,
  retentionDays: config.RETENTION_DAYS,
  logger: app.log,
});
const backfiller = new EnergyBackfiller(provider, repository, {
  days: Math.min(config.HISTORY_BACKFILL_DAYS, config.RETENTION_DAYS),
  retentionDays: config.RETENTION_DAYS,
  // Der Verlauf hat 5-Minuten-Werte; erst ab mehreren fehlenden Werten nachladen
  gapSeconds: Math.max(15 * 60, config.POLL_INTERVAL_SECONDS * 3),
  settleSeconds: 10 * 60,
  everyMinutes: 60,
  // Je 2 h Verlauf braucht Sungrow eine Abfrage pro Quelle; so bleiben höchstens ~300 Abfragen pro Stunde
  stepMinutes: 5,
  maxHoursPerStep: 24,
  logger: app.log,
});

app.addHook("onClose", async () => {
  poller.stop();
  backfiller.stop();
  await repository.close();
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "Beende Server");
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ port: config.PORT, host: config.HOST });
if (!config.APP_PASSWORD && !["127.0.0.1", "localhost", "::1"].includes(config.HOST)) {
  app.log.warn(
    `Ohne APP_PASSWORD ist die App für alle im Netz erreichbar (HOST=${config.HOST}). ` +
      "APP_PASSWORD setzen oder HOST=127.0.0.1 für nur diesen Rechner.",
  );
}
poller.start();
backfiller.start();

/**
 * Füllt die Historie mit simulierten Werten. Bei einer Datenbank wird nur der
 * Zeitraum nach dem letzten gespeicherten Messwert ergänzt.
 */
async function backfillDemo(demo: DemoEnergyProvider, repo: EnergyRepository, days: number) {
  if (days === 0) return;
  const now = new Date();
  // Nur Demo-Werte zählen; Messwerte einer anderen Quelle in derselben Datenbank sollen den Demo-Verlauf nicht verhindern
  const latest = await repo.latest("demo");
  const from = new Date(Math.max(now.getTime() - days * 86_400_000, latest ? Date.parse(latest.timestamp) + 1 : 0));
  await repo.insertMany(demo.backfill(from, now));
}
