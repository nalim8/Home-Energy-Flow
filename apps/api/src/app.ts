import { existsSync } from "node:fs";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import type { MetaResponse, WeatherResponse } from "@hef/energy-domain";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { z } from "zod";
import { registerPasswordProtection } from "./auth/password.js";
import { registerSungrowOAuth } from "./auth/sungrow-oauth.js";
import type { Config } from "./config.js";
import type { EnergyBackfiller } from "./energy/backfill.js";
import type { EnergyService } from "./energy/service.js";
import type { SungrowClient } from "./energy/sungrow/client.js";
import { dayRange, isIsoDate } from "./lib/time.js";
import type { WeatherService } from "./weather/open-meteo.js";
import type { TlsMaterial } from "./lib/tls.js";

export interface AppDependencies {
  config: Config;
  service: EnergyService;
  meta: MetaResponse;
  /** Nur gesetzt, wenn die Sungrow-Cloud die Datenquelle ist */
  sungrow?: SungrowClient;
  /** Wird nach erfolgreicher Sungrow-Autorisierung aufgerufen */
  onSungrowAuthorized?: () => void;
  /** Lädt fehlende Werte eines angefragten Zeitraums aus der Quelle nach */
  backfill?: Pick<EnergyBackfiller, "request" | "busy">;
  /** Fehlt, wenn die Wettervorhersage abgeschaltet ist */
  weather?: Pick<WeatherService, "getForecast">;
}

const dateParam = z.string().refine(isIsoDate, "Datum im Format YYYY-MM-DD erwartet");

const historyQuery = z.object({
  date: dateParam.optional(),
  bucketMinutes: z.coerce.number().int().min(1).max(60).default(5),
});
const balanceQuery = z.object({ date: dateParam.optional() });
const dailyBalancesQuery = z.object({ days: z.coerce.number().int().min(1).max(31).default(7) });
/** Höchstens ein Jahr (Schaltjahr) pro Anfrage */
const MAX_RANGE_DAYS = 366;
const rangeQuery = z
  .object({ from: dateParam, to: dateParam })
  .refine((q) => q.from <= q.to, "from darf nicht nach to liegen")
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 < MAX_RANGE_DAYS, `höchstens ${MAX_RANGE_DAYS} Tage`);

export async function buildApp(
  { config, service, meta, sungrow, onSungrowAuthorized, backfill, weather }: AppDependencies,
  options: FastifyServerOptions & { https?: TlsMaterial } = {},
): Promise<FastifyInstance> {
  // Mit https liefert Fastify einen anders typisierten Server; die Routen sind identisch
  const app = Fastify({ logger: { level: config.LOG_LEVEL }, ...options } as FastifyServerOptions);

  app.setErrorHandler((error: { statusCode?: number; message: string }, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) request.log.error({ err: error }, "Unerwarteter Fehler");
    return reply.code(statusCode).send({ error: statusCode >= 500 ? "Interner Fehler" : error.message });
  });

  if (config.APP_PASSWORD) registerPasswordProtection(app, config.APP_PASSWORD);

  app.get("/api/health", async () => ({ status: "ok" }));

  app.get("/api/meta", async () => meta);

  app.get("/api/energy/current", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return service.getCurrent();
  });

  app.get("/api/energy/history", async (request, reply) => {
    const query = historyQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: formatIssues(query.error) });
    return service.getHistory(query.data.date ?? service.today(), query.data.bucketMinutes);
  });

  app.get("/api/energy/balance", async (request, reply) => {
    const query = balanceQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: formatIssues(query.error) });
    return service.getDailyBalance(query.data.date ?? service.today());
  });

  app.get("/api/energy/balance/daily", async (request, reply) => {
    const query = dailyBalancesQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: formatIssues(query.error) });
    return service.getDailyBalances(query.data.days);
  });

  app.get("/api/energy/balance/range", async (request, reply) => {
    const query = rangeQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: formatIssues(query.error) });
    const { from, to } = query.data;
    // Im Hintergrund; das Dashboard fragt erneut an, solange backfilling true ist
    void backfill?.request(dayRange(from, config.APP_TIMEZONE).start, dayRange(to, config.APP_TIMEZONE).end);
    return { ...(await service.getRangeBalance(from, to)), backfilling: backfill?.busy ?? false };
  });

  app.get("/api/weather", async (request, reply): Promise<WeatherResponse | { error: string }> => {
    if (!weather) return { available: false, reason: "Wettervorhersage ist abgeschaltet (WEATHER_ENABLED=false)" };
    try {
      return await weather.getForecast();
    } catch (error) {
      request.log.warn({ err: error }, "Wettervorhersage nicht abrufbar");
      return reply.code(502).send({ error: "Wettervorhersage derzeit nicht abrufbar" });
    }
  });

  if (sungrow) registerSungrowOAuth(app, sungrow, onSungrowAuthorized);

  await registerFrontend(app, config.WEB_DIST_DIR);
  return app;
}

/** Liefert das gebaute Frontend aus; unbekannte Pfade fallen auf index.html zurück. */
async function registerFrontend(app: FastifyInstance, webDistDir: string | undefined) {
  const root = webDistDir ? resolve(webDistDir) : null;
  const hasFrontend = root !== null && existsSync(resolve(root, "index.html"));
  if (hasFrontend) await app.register(fastifyStatic, { root, wildcard: true });

  app.setNotFoundHandler((request, reply) => {
    const isApi = request.url.startsWith("/api/") || request.url.startsWith("/auth/");
    if (hasFrontend && request.method === "GET" && !isApi) return reply.sendFile("index.html");
    return reply.code(404).send({ error: "Nicht gefunden" });
  });
}

const formatIssues = (error: z.ZodError) =>
  error.issues.map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ");
