import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

/**
 * Client für die iSolarCloud OpenAPI (Developer Portal, OAuth 2.0).
 *
 * Ablauf: Der Nutzer autorisiert die Anwendung im Browser, iSolarCloud leitet
 * mit `code` zurück, der Code wird gegen Access und Refresh Token getauscht.
 * Jede Anfrage trägt den Secret Key als `x-access-key`, das Token als Bearer
 * und den App Key im JSON-Body. Pfade und Felder entsprechen der
 * Implementierung in pysolarcloud (MIT) und sind an echten Antworten zu prüfen.
 */

export class SungrowAuthRequiredError extends Error {
  override readonly name = "SungrowAuthRequiredError";
  readonly code = "auth_required";
}

export class SungrowApiError extends Error {
  override readonly name = "SungrowApiError";
  constructor(
    message: string,
    readonly resultCode?: string,
  ) {
    super(message);
  }
}

export interface SungrowClientOptions {
  baseUrl: string;
  appKey: string;
  secretKey: string;
  appId?: string;
  redirectUri: string;
  tokenStore: TokenStore;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  /** Zeitpunkt in ms, ab dem das Access Token erneuert wird */
  expiresAt: number;
}

export interface TokenStore {
  load(): Promise<StoredTokens | null>;
  save(tokens: StoredTokens): Promise<void>;
}

/** Speichert Tokens in einer Datei, die nicht eingecheckt werden darf. */
export class FileTokenStore implements TokenStore {
  constructor(private readonly path: string) {}

  async load(): Promise<StoredTokens | null> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as StoredTokens;
    } catch {
      return null;
    }
  }

  async save(tokens: StoredTokens): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(tokens), { encoding: "utf8", mode: 0o600 });
    await rename(tmp, this.path);
  }
}

export class MemoryTokenStore implements TokenStore {
  constructor(private tokens: StoredTokens | null = null) {}
  async load() {
    return this.tokens;
  }
  async save(tokens: StoredTokens) {
    this.tokens = tokens;
  }
}

/** Autorisierungsseite je Gateway (cloudId laut iSolarCloud) */
const AUTH_SERVERS: Record<string, { host: string; cloudId: number }> = {
  "https://gateway.isolarcloud.com": { host: "web3.isolarcloud.com", cloudId: 1 },
  "https://gateway.isolarcloud.com.hk": { host: "web3.isolarcloud.com.hk", cloudId: 2 },
  "https://gateway.isolarcloud.eu": { host: "web3.isolarcloud.eu", cloudId: 3 },
  "https://augateway.isolarcloud.com": { host: "auweb3.isolarcloud.com", cloudId: 7 },
  "https://gateway.isolarcloud.in": { host: "web3.isolarcloud.in", cloudId: 9 },
};

const tokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.coerce.number().positive(),
});

/** Antworten tragen bei Erfolg result_code "1", bei Fehlern error bzw. result_msg */
const apiEnvelope = z
  .object({
    result_code: z.coerce.string().optional(),
    result_msg: z.string().optional(),
    error: z.string().optional(),
    error_description: z.string().optional(),
    /** HTTP-Status im Body; iSolarCloud antwortet auch bei Fehlern mit HTTP 200 */
    status: z.coerce.string().optional(),
    result_data: z.unknown().optional(),
  })
  .passthrough();

/** Fehlercodes, bei denen eine neue Autorisierung nötig ist */
const AUTH_ERRORS = new Set(["invalid_token", "invalid_grant", "unauthorized", "expired_token"]);

const pointDict = z
  .array(
    z
      .object({
        point_id: z.coerce.string(),
        point_name: z.string().nullish(),
        point_unit: z.string().nullish(),
      })
      .passthrough(),
  )
  .default([]);

/** Trennt Messpunkte (Schlüssel p<ID>) von übrigen Feldern und ergänzt Name und Einheit. */
function extractPoints(record: Record<string, unknown>, dictionary: z.infer<typeof pointDict>) {
  const dict = new Map(dictionary.map((p) => [p.point_id, p]));
  const points = new Map<string, RealtimePoint>();
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const match = /^p(\d+)$/.exec(key);
    if (!match) {
      extra[key] = value;
      continue;
    }
    const id = match[1]!;
    points.set(id, {
      id,
      name: dict.get(id)?.point_name ?? null,
      unit: dict.get(id)?.point_unit ?? null,
      value: typeof value === "number" || typeof value === "string" ? value : null,
    });
  }
  return { points, extra };
}

export interface HistoryRow {
  /** Ortszeit der Anlage, „yyyyMMddHHmmss“ */
  timeStamp: string;
  points: Map<string, RealtimePoint>;
}

/** Verlaufszeilen { time_stamp, p<ID>: Wert } unter dem Schlüssel der Anlage bzw. des Geräts */
function historyRows(data: unknown, key: string): HistoryRow[] {
  const parsed = z.record(z.array(z.object({ time_stamp: z.string() }).passthrough())).parse(data ?? {});
  return (parsed[key] ?? []).map((row) => ({ timeStamp: row.time_stamp, points: extractPoints(row, []).points }));
}

export interface Plant {
  ps_id: number | string;
  ps_name?: string;
  [key: string]: unknown;
}

export interface Device {
  ps_key: string;
  /** z. B. 14 Hybrid-Wechselrichter, 7 Zähler, 43 Batterie */
  device_type: number;
  device_name?: string;
  type_name?: string;
  [key: string]: unknown;
}

export interface RealtimePoint {
  id: string;
  name: string | null;
  unit: string | null;
  /** Rohwert; Zahlen kommen als String */
  value: string | number | null;
}

export interface PlantRealtime {
  psId: string;
  points: Map<string, RealtimePoint>;
  /** Felder ohne Messpunkt (z. B. Zeitstempel), für die Diagnose */
  extra: Record<string, unknown>;
}

export class SungrowClient {
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private refreshing: Promise<StoredTokens> | null = null;

  constructor(private readonly options: SungrowClientOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  /** Muss zeichengenau der im Developer Portal hinterlegten Redirect URI entsprechen */
  get redirectUri(): string {
    return this.options.redirectUri;
  }

  /** URL, unter der der Nutzer die Anwendung freigibt. `state` muss vor dem # stehen. */
  authorizeUrl(state: string): string {
    const server = AUTH_SERVERS[this.options.baseUrl.replace(/\/$/, "")];
    if (!server) throw new Error(`Unbekanntes iSolarCloud-Gateway: ${this.options.baseUrl}`);
    if (!this.options.appId) {
      throw new Error("SUNGROW_APP_ID fehlt (Application ID aus der Authorize-URL im Developer Portal)");
    }
    // Das Portal vergleicht redirectUrl roh mit der registrierten URI, daher unkodiert wie in der Portal-Authorize-URL
    const fragment =
      `cloudId=${server.cloudId}&applicationId=${encodeURIComponent(this.options.appId)}` +
      `&redirectUrl=${this.options.redirectUri}`;
    return `https://${server.host}/?state=${encodeURIComponent(state)}#/authorized-app?${fragment}`;
  }

  async isAuthorized(): Promise<boolean> {
    return (await this.options.tokenStore.load()) !== null;
  }

  /** Tauscht den Autorisierungscode gegen Tokens und speichert sie. */
  async exchangeCode(code: string): Promise<void> {
    const body = await this.post("/openapi/apiManage/token", {
      appkey: this.options.appKey,
      code,
      grant_type: "authorization_code",
      redirect_uri: this.options.redirectUri,
    });
    await this.storeTokens(body);
  }

  async listPlants(): Promise<Plant[]> {
    const data = await this.call("/openapi/platform/queryPowerStationList", { page: 1, size: 100 });
    const parsed = z.object({ pageList: z.array(z.object({ ps_id: z.union([z.number(), z.string()]) }).passthrough()) });
    return parsed.parse(data).pageList as Plant[];
  }

  /** Aktuelle Messwerte einer Anlage. Ohne pointIds liefert die API alle verfügbaren Punkte. */
  async realtime(psId: string, pointIds: readonly string[]): Promise<PlantRealtime> {
    const data = await this.call("/openapi/platform/getPowerStationRealTimeData", {
      ps_id_list: [psId],
      point_id_list: pointIds,
      is_get_point_dict: "1",
    });
    const parsed = z
      .object({
        device_point_list: z.array(z.record(z.unknown())),
        point_dict: pointDict,
      })
      .parse(data);

    const plant = parsed.device_point_list.find((p) => String(p.ps_id) === String(psId));
    if (!plant) throw new SungrowApiError(`Keine Echtzeitdaten für Anlage ${psId}`);
    return { psId: String(psId), ...extractPoints(plant, parsed.point_dict) };
  }

  async listDevices(psId: string): Promise<Device[]> {
    const data = await this.call("/openapi/platform/getDeviceListByPsId", { ps_id: psId, page: 1, size: 100 });
    const parsed = z.object({
      pageList: z.array(z.object({ ps_key: z.string(), device_type: z.coerce.number() }).passthrough()),
    });
    return parsed.parse(data).pageList as Device[];
  }

  /** Echtzeitdaten eines Geräts; manche Werte (Netz, SOC) liefert nur das Gerät, nicht die Anlage. */
  async deviceRealtime(deviceType: number, psKey: string, pointIds: readonly string[]) {
    const data = await this.call("/openapi/platform/getDeviceRealTimeData", {
      device_type: deviceType,
      ps_key_list: [psKey],
      point_id_list: pointIds,
      is_get_point_dict: "1",
    });
    const parsed = z
      .object({
        device_point_list: z.array(z.object({ device_point: z.record(z.unknown()) })),
        point_dict: pointDict,
      })
      .parse(data);
    const device = parsed.device_point_list.find((d) => d.device_point.ps_key === psKey)?.device_point;
    if (!device) throw new SungrowApiError(`Keine Echtzeitdaten für Gerät ${psKey}`);
    return extractPoints(device, parsed.point_dict);
  }

  /**
   * 5-Minuten-Verlauf der Anlage. Zeiten als „yyyyMMddHHmmss“ in Ortszeit der Anlage;
   * die API erlaubt höchstens 3 Stunden pro Anfrage.
   */
  async plantHistory(psId: string, pointIds: readonly string[], start: string, end: string) {
    const data = await this.call("/openapi/platform/getPowerStationPointMinuteDataList", {
      ps_id_list: [psId],
      points: pointIds.map((id) => `p${id}`).join(","),
      start_time_stamp: start,
      end_time_stamp: end,
      minute_interval: 5,
    });
    return historyRows(data, psId);
  }

  /** 5-Minuten-Verlauf eines Geräts; Format und Grenzen wie plantHistory. */
  async deviceHistory(psKey: string, pointIds: readonly string[], start: string, end: string) {
    const data = await this.call("/openapi/platform/getDevicePointMinuteDataList", {
      ps_key_list: [psKey],
      points: pointIds.map((id) => `p${id}`).join(","),
      start_time_stamp: start,
      end_time_stamp: end,
      minute_interval: 5,
    });
    return historyRows(data, psKey);
  }

  /** Authentifizierte Anfrage; gibt result_data zurück. */
  private async call(path: string, data: Record<string, unknown>): Promise<unknown> {
    const tokens = await this.validTokens();
    const body = await this.post(path, { ...data, appkey: this.options.appKey, lang: "_de_DE" }, tokens.accessToken);
    return body.result_data;
  }

  private async validTokens(): Promise<StoredTokens> {
    const tokens = await this.options.tokenStore.load();
    if (!tokens) {
      throw new SungrowAuthRequiredError("Sungrow ist noch nicht autorisiert – /auth/sungrow/login aufrufen");
    }
    if (tokens.expiresAt > this.now()) return tokens;
    // Parallele Anfragen teilen sich eine Erneuerung
    this.refreshing ??= this.refresh(tokens.refreshToken).finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async refresh(refreshToken: string): Promise<StoredTokens> {
    try {
      const body = await this.post("/openapi/apiManage/refreshToken", {
        appkey: this.options.appKey,
        refresh_token: refreshToken,
      });
      return await this.storeTokens(body);
    } catch (error) {
      if (error instanceof SungrowAuthRequiredError) throw error;
      throw new SungrowAuthRequiredError(
        `Token-Erneuerung fehlgeschlagen (${error instanceof Error ? error.message : error}) – /auth/sungrow/login aufrufen`,
      );
    }
  }

  private async storeTokens(body: z.infer<typeof apiEnvelope>): Promise<StoredTokens> {
    // Manche Antworten verpacken die Tokens in result_data
    const parsed = tokenResponse.safeParse(body.result_data ?? body);
    if (!parsed.success) throw new SungrowApiError("Antwort enthält keine gültigen Tokens");
    const tokens: StoredTokens = {
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token,
      // 60 s Puffer, damit kein Token während einer Anfrage abläuft
      expiresAt: this.now() + (parsed.data.expires_in - 60) * 1000,
    };
    await this.options.tokenStore.save(tokens);
    return tokens;
  }

  private async post(path: string, body: Record<string, unknown>, accessToken?: string) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-access-key": this.options.secretKey,
    };
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;

    const response = await this.fetch(`${this.options.baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
    });
    const json = (await response.json().catch(() => null)) as unknown;
    if (response.status === 401) throw new SungrowAuthRequiredError("Sungrow lehnt das Token ab – /auth/sungrow/login aufrufen");
    if (!response.ok || json === null) throw new SungrowApiError(`HTTP ${response.status} von ${path}`);

    const envelope = apiEnvelope.parse(json);
    if (envelope.error) {
      const message = `${envelope.error}${envelope.error_description ? `: ${envelope.error_description}` : ""}`;
      if (AUTH_ERRORS.has(envelope.error.toLowerCase()) || envelope.status === "401") throw new SungrowAuthRequiredError(`${message} – /auth/sungrow/login aufrufen`);
      throw new SungrowApiError(message);
    }
    if (envelope.result_code !== undefined && envelope.result_code !== "1") {
      throw new SungrowApiError(envelope.result_msg ?? `Fehlercode ${envelope.result_code}`, envelope.result_code);
    }
    return envelope;
  }
}
