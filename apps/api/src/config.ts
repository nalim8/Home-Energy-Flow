import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * Projektwurzel. Quelltext (apps/api/src) und Bundle (apps/api/dist) liegen
 * gleich tief, daher funktioniert derselbe relative Pfad in beiden Fällen.
 */
export const PROJECT_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);
const optionalString = z.preprocess(emptyToUndefined, z.string().optional());
const optionalInt = z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional());
const sign = z.enum(["positive", "negative"]);

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  /** 127.0.0.1: nur dieser Rechner; 0.0.0.0: ganzes Netz (dann APP_PASSWORD setzen) */
  HOST: z.string().default("0.0.0.0"),
  /** Schützt App und API per Browser-Anmeldung (HTTP Basic); Benutzername beliebig */
  APP_PASSWORD: optionalString,
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  APP_TIMEZONE: z.string().default("Europe/Berlin"),

  ENERGY_PROVIDER: z.enum(["demo", "sungrow-cloud"]).default("demo"),
  /** Standard: 30 s im Demo-Modus, 300 s für die Sungrow-Cloud (aktualisiert alle 5 min) */
  POLL_INTERVAL_SECONDS: z.preprocess(emptyToUndefined, z.coerce.number().int().min(5).optional()),
  /** Standard: dreifaches Abrufintervall */
  STALE_AFTER_SECONDS: optionalInt,

  /** Ohne DATABASE_URL werden Messwerte nur im Arbeitsspeicher gehalten. */
  DATABASE_URL: optionalString,
  /** Standard reicht für die Jahresansicht im Dashboard */
  RETENTION_DAYS: z.coerce.number().int().positive().default(400),
  DEMO_BACKFILL_DAYS: z.coerce.number().int().min(0).max(30).default(7),
  /** Lücken der letzten Tage aus dem Verlauf der Quelle füllen (nur Sungrow-Cloud); 0 schaltet ab */
  HISTORY_BACKFILL_DAYS: z.coerce.number().int().min(0).default(7),

  /** Wettervorhersage über Open-Meteo; Standort ohne Angabe aus der Sungrow-Anlage */
  WEATHER_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  WEATHER_LATITUDE: z.preprocess(emptyToUndefined, z.coerce.number().min(-90).max(90).optional()),
  WEATHER_LONGITUDE: z.preprocess(emptyToUndefined, z.coerce.number().min(-180).max(180).optional()),
  /** Anlagenleistung in kWp; ohne Angabe keine PV-Prognose */
  PV_PEAK_KW: z.preprocess(emptyToUndefined, z.coerce.number().positive().optional()),
  /** Modulneigung in Grad (0 = waagerecht) */
  PV_TILT_DEG: z.coerce.number().min(0).max(90).default(30),
  /** Ausrichtung in Grad: 0 = Süd, -90 = Ost, 90 = West */
  PV_AZIMUTH_DEG: z.coerce.number().min(-180).max(180).default(0),
  /** Anteil der Modulleistung, der nach Verlusten ankommt */
  PV_PERFORMANCE_RATIO: z.coerce.number().min(0.1).max(1).default(0.85),

  /** Lokales HTTPS, z. B. weil iSolarCloud nur https-Redirect-URIs akzeptiert */
  HTTPS: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  /** Eigene Zertifikatsdateien (z. B. mkcert); ohne Angabe wird selbst signiert */
  TLS_CERT_FILE: optionalString,
  TLS_KEY_FILE: optionalString,
  TLS_DIR: z.string().default(".certs"),

  /** Verzeichnis des gebauten Frontends; wird in Produktion von Fastify ausgeliefert. */
  WEB_DIST_DIR: optionalString,

  /** JSON-Datei mit { "appKey", "secretKey", "appId"? } als Alternative zu den Variablen */
  SUNGROW_CONFIG_FILE: z.string().default("config.json"),
  SUNGROW_APP_KEY: optionalString,
  SUNGROW_APP_SECRET: optionalString,
  /** Application ID aus der Authorize-URL im Developer Portal */
  SUNGROW_APP_ID: optionalString,
  /** Gateway der Region, Europa: https://gateway.isolarcloud.eu */
  SUNGROW_API_BASE_URL: z.string().url().default("https://gateway.isolarcloud.eu"),
  /** Muss exakt mit der im Developer Portal hinterlegten Redirect URI übereinstimmen */
  SUNGROW_REDIRECT_URI: z.string().url().default("http://localhost:3000/auth/callback"),
  /** Speicherort von Access und Refresh Token */
  SUNGROW_TOKEN_FILE: z.string().default(".sungrow-token.json"),
  /** Anlage; ohne Angabe wird die einzige Anlage des Kontos verwendet */
  SUNGROW_PS_ID: optionalString,

  // Messpunkt-IDs der Anlage (getPowerStationRealTimeData) oder eines Geräts mit Typ-Präfix,
  // z. B. "14:13149-13121" = Netzbezug minus Einspeisung am Hybrid-Wechselrichter. Mit `npm run sungrow:inspect` prüfen.
  SUNGROW_POINT_PV: z.string().default("83067"),
  SUNGROW_POINT_LOAD: z.string().default("83106"),
  SUNGROW_POINT_GRID: z.string().default("83549"),
  /** Leer: Batterieleistung wird aus der Bilanz der übrigen Messwerte berechnet */
  SUNGROW_POINT_BATTERY: z.string().default(""),
  SUNGROW_POINT_SOC: z.string().default("83252"),
  /** Vorzeichen, das Sungrow beim Netzbezug liefert */
  SUNGROW_GRID_IMPORT_SIGN: sign.default("positive"),
  /** Vorzeichen, das Sungrow beim Laden des Speichers liefert */
  SUNGROW_BATTERY_CHARGE_SIGN: sign.default("positive"),
});

export type Env = z.infer<typeof envSchema>;

export interface Config extends Omit<Env, "POLL_INTERVAL_SECONDS" | "STALE_AFTER_SECONDS"> {
  POLL_INTERVAL_SECONDS: number;
  STALE_AFTER_SECONDS: number;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env, root = PROJECT_ROOT): Config {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Ungültige Konfiguration: ${details}`);
  }
  const env = parsed.data;
  const poll = env.POLL_INTERVAL_SECONDS ?? (env.ENERGY_PROVIDER === "sungrow-cloud" ? 300 : 30);

  const fromFile = readSungrowConfigFile(resolve(root, env.SUNGROW_CONFIG_FILE));
  return {
    ...env,
    SUNGROW_APP_KEY: env.SUNGROW_APP_KEY ?? fromFile.appKey,
    SUNGROW_APP_SECRET: env.SUNGROW_APP_SECRET ?? fromFile.secretKey,
    SUNGROW_APP_ID: env.SUNGROW_APP_ID ?? fromFile.appId,
    SUNGROW_TOKEN_FILE: resolve(root, env.SUNGROW_TOKEN_FILE),
    TLS_CERT_FILE: env.TLS_CERT_FILE && resolve(root, env.TLS_CERT_FILE),
    TLS_KEY_FILE: env.TLS_KEY_FILE && resolve(root, env.TLS_KEY_FILE),
    TLS_DIR: resolve(root, env.TLS_DIR),
    POLL_INTERVAL_SECONDS: poll,
    STALE_AFTER_SECONDS: env.STALE_AFTER_SECONDS ?? poll * 3,
  };
}

const configFileSchema = z.object({
  appKey: z.string().min(1).optional(),
  secretKey: z.string().min(1).optional(),
  appId: z.coerce.string().min(1).optional(),
});

function readSungrowConfigFile(path: string): z.infer<typeof configFileSchema> {
  if (!existsSync(path)) return {};
  try {
    return configFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw new Error(`Sungrow-Konfiguration ${path} ist ungültig`, { cause: error });
  }
}
