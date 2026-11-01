import type { EnergySnapshot } from "@hef/energy-domain";
import type { Config } from "../config.js";
import type { EnergyProvider } from "./provider.js";
import { zonedParts } from "../lib/time.js";
import {
  FileTokenStore,
  SungrowClient,
  type Device,
  type HistoryRow,
  type RealtimePoint,
  type TokenStore,
} from "./sungrow/client.js";
import {
  mapRealtime,
  parseDeviceTime,
  parsePointSpec,
  pointKey,
  SungrowMappingError,
  type PointMapping,
} from "./sungrow/mapping.js";

/**
 * Die API erlaubt 3 Stunden pro Verlaufsabfrage, gemessen in Ortszeit. 2 Stunden
 * bleiben auch beim Wechsel auf Sommerzeit (eine Ortsstunde mehr) darunter.
 */
const HISTORY_CHUNK_MS = 2 * 60 * 60 * 1000;

export class SungrowNotConfiguredError extends Error {
  override readonly name = "SungrowNotConfiguredError";
}

/**
 * Liest die Anlage über die offizielle iSolarCloud OpenAPI. Nur Lesezugriff,
 * keine Steuerung. iSolarCloud aktualisiert die Werte etwa alle 5 Minuten.
 */
export class SungrowCloudProvider implements EnergyProvider {
  readonly source = "sungrow-cloud" as const;
  readonly client: SungrowClient;
  private readonly mapping: PointMapping;
  private psId: string | undefined;
  private devices: Device[] | undefined;
  private readonly now: () => Date;
  /** Zeitzone, in der Sungrow device_time angibt (Ortszeit der Anlage) */
  private readonly timeZone: string;
  /** Letzte Werte ohne device_time, um unveränderte Cloud-Daten zu erkennen */
  private lastUntimed: { signature: string; measuredAt: Date } | null = null;

  constructor(
    config: Config,
    options: { tokenStore?: TokenStore; fetch?: typeof fetch; now?: () => Date } = {},
  ) {
    if (!config.SUNGROW_APP_KEY || !config.SUNGROW_APP_SECRET) {
      throw new SungrowNotConfiguredError(
        "App Key und Secret Key fehlen: SUNGROW_APP_KEY/SUNGROW_APP_SECRET oder config.json mit appKey/secretKey",
      );
    }
    this.client = new SungrowClient({
      baseUrl: config.SUNGROW_API_BASE_URL,
      appKey: config.SUNGROW_APP_KEY,
      secretKey: config.SUNGROW_APP_SECRET,
      appId: config.SUNGROW_APP_ID,
      redirectUri: config.SUNGROW_REDIRECT_URI,
      tokenStore: options.tokenStore ?? new FileTokenStore(config.SUNGROW_TOKEN_FILE),
      fetch: options.fetch,
    });
    this.mapping = mappingFromConfig(config);
    this.psId = config.SUNGROW_PS_ID;
    this.now = options.now ?? (() => new Date());
    this.timeZone = config.APP_TIMEZONE;
  }

  async getCurrentSnapshot(): Promise<EnergySnapshot> {
    const { points, measuredAt } = await this.fetchPoints();
    return mapRealtime(points, this.mapping, measuredAt);
  }

  /**
   * Liest alle Punkte der Zuordnung; Schlüssel wie in parsePointSpec ("83106", "14:13149").
   * Messzeitpunkt ist der älteste device_time der Antworten. Die Anlagenabfrage liefert
   * keinen; ohne Gerätepunkte gilt daher der Abrufzeitpunkt – außer die Werte sind exakt
   * dieselben wie beim letzten Abruf. Dann hat die Cloud nichts Neues (z. B. Datenlogger
   * offline), und der Messwert behält seinen alten Zeitpunkt, statt als frisch zu gelten.
   */
  async fetchPoints(): Promise<{ points: Map<string, RealtimePoint>; measuredAt: Date }> {
    const psId = await this.resolvePlant();
    const { plantIds, byDevice } = this.groupedPoints();

    const points = new Map<string, RealtimePoint>();
    const times: Date[] = [];
    const collect = (deviceType: number | null, result: { points: Map<string, RealtimePoint>; extra: Record<string, unknown> }) => {
      for (const [id, p] of result.points) points.set(pointKey(deviceType, id), p);
      const time = parseDeviceTime(result.extra.device_time, this.timeZone);
      if (time) times.push(time);
    };

    if (plantIds.length > 0) collect(null, await this.client.realtime(psId, plantIds));
    for (const [deviceType, ids] of byDevice) {
      const psKey = await this.resolveDevice(psId, deviceType);
      collect(deviceType, await this.client.deviceRealtime(deviceType, psKey, ids));
    }

    const now = this.now();
    if (times.length === 0) {
      const signature = JSON.stringify([...points].map(([key, p]) => [key, p.value]).sort());
      if (this.lastUntimed?.signature !== signature) this.lastUntimed = { signature, measuredAt: now };
      return { points, measuredAt: this.lastUntimed.measuredAt };
    }
    const oldest = Math.min(...times.map((t) => t.getTime()));
    // Ein Zeitstempel in der Zukunft deutet auf eine abweichende Zeitzone der Anlage hin
    return { points, measuredAt: new Date(Math.min(oldest, now.getTime())) };
  }

  /**
   * 5-Minuten-Werte im Intervall [start, end] aus dem Verlauf von iSolarCloud.
   * Zeitpunkte, an denen ein Pflichtwert fehlt, werden übersprungen.
   */
  async getHistory(start: Date, end: Date): Promise<EnergySnapshot[]> {
    const psId = await this.resolvePlant();
    const { plantIds, byDevice } = this.groupedPoints();
    /** Werte je Zeitpunkt (UTC-Millisekunden) */
    const rows = new Map<number, Map<string, RealtimePoint>>();

    for (let from = start.getTime(); from < end.getTime(); from += HISTORY_CHUNK_MS) {
      const to = Math.min(from + HISTORY_CHUNK_MS, end.getTime());
      const merge = (deviceType: number | null, history: HistoryRow[]) => {
        // Bei der Rückstellung auf Winterzeit kommt jede Ortszeit zwischen 2 und 3 Uhr zweimal vor
        const seen = new Map<string, number>();
        for (const row of history) {
          const occurrence = seen.get(row.timeStamp) ?? 0;
          seen.set(row.timeStamp, occurrence + 1);
          const at = this.resolveStamp(row.timeStamp, from, to, occurrence);
          if (at === null) continue;
          const points = rows.get(at) ?? new Map<string, RealtimePoint>();
          for (const [id, p] of row.points) points.set(pointKey(deviceType, id), p);
          rows.set(at, points);
        }
      };
      const chunkStart = this.localStamp(new Date(from));
      const chunkEnd = this.localStamp(new Date(to));
      if (plantIds.length > 0) merge(null, await this.client.plantHistory(psId, plantIds, chunkStart, chunkEnd));
      for (const [deviceType, ids] of byDevice) {
        const psKey = await this.resolveDevice(psId, deviceType);
        merge(deviceType, await this.client.deviceHistory(psKey, ids, chunkStart, chunkEnd));
      }
    }

    const snapshots: EnergySnapshot[] = [];
    for (const [at, points] of rows) {
      if (at < start.getTime() || at > end.getTime()) continue;
      try {
        snapshots.push(mapRealtime(points, this.mapping, new Date(at)));
      } catch (error) {
        if (!(error instanceof SungrowMappingError)) throw error;
      }
    }
    return snapshots.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  /**
   * Ortszeit „yyyyMMddHHmmss“ als UTC-Millisekunden innerhalb des abgefragten Stücks.
   * Ist sie wegen der Zeitumstellung mehrdeutig, entscheidet das wievielte Vorkommen.
   */
  private resolveStamp(stamp: string, from: number, to: number, occurrence: number): number | null {
    const base = parseDeviceTime(stamp, this.timeZone)?.getTime();
    if (base === undefined) return null;
    const candidates = [base - 3_600_000, base, base + 3_600_000].filter(
      (t) => t >= from && t <= to && this.localStamp(new Date(t)) === stamp,
    );
    return candidates[Math.min(occurrence, candidates.length - 1)] ?? null;
  }

  private groupedPoints() {
    const { pv, load, grid, battery, soc } = this.mapping;
    const terms = [pv, load, grid, battery, soc].filter(Boolean).flatMap(parsePointSpec);
    const plantIds = [...new Set(terms.filter((t) => t.deviceType === null).map((t) => t.id))];
    const byDevice = new Map<number, string[]>();
    for (const t of terms) {
      if (t.deviceType === null) continue;
      const ids = byDevice.get(t.deviceType) ?? [];
      if (!ids.includes(t.id)) ids.push(t.id);
      byDevice.set(t.deviceType, ids);
    }
    return { plantIds, byDevice };
  }

  /** „yyyyMMddHHmmss“ in Ortszeit der Anlage */
  private localStamp(date: Date): string {
    const p = zonedParts(date, this.timeZone);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${p.year}${pad(p.month)}${pad(p.day)}${pad(p.hour)}${pad(p.minute)}${pad(p.second)}`;
  }

  /** Standort laut iSolarCloud; null, wenn die Anlage keinen hinterlegt hat */
  async location(): Promise<{ latitude: number; longitude: number } | null> {
    const psId = await this.resolvePlant();
    const plant = (await this.client.listPlants()).find((p) => String(p.ps_id) === psId);
    const latitude = Number(plant?.latitude);
    const longitude = Number(plant?.longitude);
    return Number.isFinite(latitude) && Number.isFinite(longitude) && (latitude !== 0 || longitude !== 0)
      ? { latitude, longitude }
      : null;
  }

  private async resolveDevice(psId: string, deviceType: number): Promise<string> {
    this.devices ??= await this.client.listDevices(psId);
    const device = this.devices.find((d) => d.device_type === deviceType);
    if (!device) {
      const types = this.devices.map((d) => `${d.device_type} (${d.type_name ?? d.device_name ?? "?"})`).join(", ");
      throw new SungrowNotConfiguredError(`Kein Gerät vom Typ ${deviceType} in der Anlage; vorhanden: ${types}`);
    }
    return device.ps_key;
  }

  private async resolvePlant(): Promise<string> {
    if (this.psId) return this.psId;
    const plants = await this.client.listPlants();
    if (plants.length !== 1) {
      const list = plants.map((p) => `${p.ps_id} (${p.ps_name ?? "ohne Namen"})`).join(", ");
      throw new SungrowNotConfiguredError(
        plants.length === 0 ? "Keine Anlage im Konto freigegeben" : `Mehrere Anlagen gefunden, SUNGROW_PS_ID setzen: ${list}`,
      );
    }
    this.psId = String(plants[0]!.ps_id);
    return this.psId;
  }
}

export function mappingFromConfig(config: Config): PointMapping {
  return {
    pv: config.SUNGROW_POINT_PV,
    load: config.SUNGROW_POINT_LOAD,
    grid: config.SUNGROW_POINT_GRID,
    battery: config.SUNGROW_POINT_BATTERY,
    soc: config.SUNGROW_POINT_SOC,
    gridImportSign: config.SUNGROW_GRID_IMPORT_SIGN,
    batteryChargeSign: config.SUNGROW_BATTERY_CHARGE_SIGN,
  };
}
