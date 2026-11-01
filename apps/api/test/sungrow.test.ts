import { computeFlows } from "@hef/energy-domain";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerSungrowOAuth } from "../src/auth/sungrow-oauth.js";
import { SungrowCloudProvider } from "../src/energy/sungrow-cloud-provider.js";
import {
  MemoryTokenStore,
  SungrowAuthRequiredError,
  SungrowClient,
  type RealtimePoint,
} from "../src/energy/sungrow/client.js";
import {
  mapRealtime,
  parseDeviceTime,
  parsePointSpec,
  socPercent,
  type PointMapping,
} from "../src/energy/sungrow/mapping.js";
import { testConfig } from "./helpers.js";

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Simuliert das iSolarCloud-Gateway und zeichnet Anfragen auf. */
function fakeGateway(routes: Record<string, (body: Record<string, unknown>) => unknown>) {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url, headers: init?.headers as Record<string, string>, body });
    const route = routes[new URL(url).pathname];
    if (!route) return new Response("not found", { status: 404 });
    return Response.json(route(body));
  }) as typeof fetch;
  return { fetchFn, calls };
}

const TOKENS = { access_token: "acc-1", refresh_token: "ref-1", expires_in: 3600 };

function client(fetchFn: typeof fetch, tokens = new MemoryTokenStore(), now = () => 1_000_000) {
  return new SungrowClient({
    baseUrl: "https://gateway.isolarcloud.eu",
    appKey: "APPKEY",
    secretKey: "SECRET",
    appId: "1234",
    redirectUri: "http://localhost:3000/auth/callback",
    tokenStore: tokens,
    fetch: fetchFn,
    now,
  });
}

const point = (id: string, value: string | number | null, unit: string | null = "W"): [string, RealtimePoint] => [
  id,
  { id, name: null, unit, value },
];

const MAPPING: PointMapping = {
  pv: "83067",
  load: "83106",
  grid: "83549",
  battery: "",
  soc: "83252",
  gridImportSign: "positive",
  batteryChargeSign: "positive",
};

describe("SungrowClient", () => {
  it("baut die Autorisierungs-URL mit state vor dem Fragment", () => {
    const url = client(fakeGateway({}).fetchFn).authorizeUrl("abc");
    expect(url).toBe(
      "https://web3.isolarcloud.eu/?state=abc#/authorized-app?cloudId=3&applicationId=1234&redirectUrl=http://localhost:3000/auth/callback",
    );
  });

  it("tauscht den Code und sendet Secret nur als Header", async () => {
    const { fetchFn, calls } = fakeGateway({ "/openapi/apiManage/token": () => TOKENS });
    const store = new MemoryTokenStore();
    await client(fetchFn, store).exchangeCode("the-code");

    expect(calls[0]!.headers["x-access-key"]).toBe("SECRET");
    expect(calls[0]!.body).toEqual({
      appkey: "APPKEY",
      code: "the-code",
      grant_type: "authorization_code",
      redirect_uri: "http://localhost:3000/auth/callback",
    });
    expect(await store.load()).toMatchObject({ accessToken: "acc-1", refreshToken: "ref-1" });
  });

  it("erneuert abgelaufene Tokens vor der Anfrage", async () => {
    const { fetchFn, calls } = fakeGateway({
      "/openapi/apiManage/refreshToken": () => ({ ...TOKENS, access_token: "acc-2" }),
      "/openapi/platform/queryPowerStationList": () => ({ result_code: "1", result_data: { pageList: [{ ps_id: 42 }] } }),
    });
    const store = new MemoryTokenStore({ accessToken: "old", refreshToken: "ref-1", expiresAt: 0 });

    const plants = await client(fetchFn, store).listPlants();
    expect(plants).toEqual([{ ps_id: 42 }]);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/openapi/apiManage/refreshToken",
      "/openapi/platform/queryPowerStationList",
    ]);
    expect(calls[1]!.headers.authorization).toBe("Bearer acc-2");
  });

  it("verlangt eine Anmeldung, wenn keine Tokens vorliegen", async () => {
    await expect(client(fakeGateway({}).fetchFn).listPlants()).rejects.toBeInstanceOf(SungrowAuthRequiredError);
  });

  it("erkennt Autorisierungsfehler im Body trotz HTTP 200", async () => {
    // Format einer echten Antwort des EU-Gateways
    const { fetchFn } = fakeGateway({
      "/openapi/platform/queryPowerStationList": () => ({
        result_msg: "Unauthorized",
        result_code: "3",
        error: "Unauthorized",
        status: "401",
      }),
    });
    const store = new MemoryTokenStore({ accessToken: "a", refreshToken: "r", expiresAt: Infinity });
    await expect(client(fetchFn, store).listPlants()).rejects.toBeInstanceOf(SungrowAuthRequiredError);
  });

  it("meldet API-Fehler mit result_msg", async () => {
    const { fetchFn } = fakeGateway({
      "/openapi/platform/queryPowerStationList": () => ({ result_code: "E900", result_msg: "illegal access" }),
    });
    const store = new MemoryTokenStore({ accessToken: "a", refreshToken: "r", expiresAt: Infinity });
    await expect(client(fetchFn, store).listPlants()).rejects.toThrow("illegal access");
  });

  it("liest Echtzeitdaten samt Einheiten", async () => {
    const { fetchFn } = fakeGateway({
      "/openapi/platform/getPowerStationRealTimeData": () => ({
        result_code: "1",
        result_data: {
          device_point_list: [{ ps_id: 42, p83067: "3200.0", p83252: "0.78", device_time: "20261029120000" }],
          point_dict: [
            { point_id: 83067, point_name: "PV-Leistung", point_unit: "W" },
            { point_id: 83252, point_name: "SOC", point_unit: "" },
          ],
        },
      }),
    });
    const store = new MemoryTokenStore({ accessToken: "a", refreshToken: "r", expiresAt: Infinity });
    const data = await client(fetchFn, store).realtime("42", ["83067", "83252"]);
    expect(data.points.get("83067")).toEqual({ id: "83067", name: "PV-Leistung", unit: "W", value: "3200.0" });
    expect(data.extra).toEqual({ ps_id: 42, device_time: "20261029120000" });
  });
});

describe("mapRealtime", () => {
  const at = new Date("2026-06-21T10:00:00Z");

  it("berechnet die Batterieleistung aus der Bilanz", () => {
    const points = new Map([point("83067", "3200"), point("83106", "1100"), point("83549", "-400"), point("83252", "0.78", "")]);
    const s = mapRealtime(points, MAPPING, at);
    expect(s).toMatchObject({ pvPowerW: 3200, householdPowerW: 1100, batteryPowerW: 1700, batterySocPercent: 78 });
    expect(s).toMatchObject({ gridPowerW: 400, gridDirection: "export", source: "sungrow-cloud" });
    expect(computeFlows(s).unbalancedW).toBe(0);
  });

  it("übernimmt gemessene Batterieleistung mit konfiguriertem Vorzeichen", () => {
    const points = new Map([
      point("83067", "0"),
      point("83106", "2.5", "kW"),
      point("83549", "-0.5", "kW"),
      point("83326", "2000"),
      point("83252", "35", "%"),
    ]);
    const s = mapRealtime(
      points,
      { ...MAPPING, battery: "83326", gridImportSign: "negative", batteryChargeSign: "negative" },
      at,
    );
    expect(s).toMatchObject({ householdPowerW: 2500, gridDirection: "import", gridPowerW: 500, batteryPowerW: -2000 });
    expect(s.batterySocPercent).toBe(35);
  });

  it("verweigert fehlende oder ungültige Werte", () => {
    expect(() => mapRealtime(new Map([point("83067", "100")]), MAPPING, at)).toThrow("Hausverbrauch");
    expect(() =>
      mapRealtime(new Map([point("83067", "--"), point("83106", "1"), point("83549", "1"), point("83252", "1")]), MAPPING, at),
    ).toThrow("kein Zahlenwert");
  });

  it("liest Gerätepunkte und Differenzen", () => {
    expect(parsePointSpec("14:13149-13121")).toEqual([
      { deviceType: 14, id: "13149", sign: 1, key: "14:13149" },
      { deviceType: 14, id: "13121", sign: -1, key: "14:13121" },
    ]);
    expect(() => parsePointSpec("abc")).toThrow("Ungültiger Messpunkt-Ausdruck");

    const points = new Map([
      point("83033", "443"),
      point("83106", "187"),
      point("14:13149", "0"),
      point("14:13121", "50"),
      point("43:58604", "0.072", ""),
    ]);
    const s = mapRealtime(points, { ...MAPPING, pv: "83033", grid: "14:13149-13121", soc: "43:58604" }, at);
    expect(s).toMatchObject({ pvPowerW: 443, gridDirection: "export", gridPowerW: 50, batteryPowerW: 206, batterySocPercent: 7.2 });
  });

  it("liest device_time in Ortszeit der Anlage", () => {
    expect(parseDeviceTime("20260621120000", "Europe/Berlin")).toEqual(new Date("2026-06-21T10:00:00Z"));
    expect(parseDeviceTime("20261101101500", "Europe/Berlin")).toEqual(new Date("2026-11-01T09:15:00Z"));
    expect(parseDeviceTime(null, "Europe/Berlin")).toBeNull();
    expect(parseDeviceTime("2026-11-01", "Europe/Berlin")).toBeNull();
  });

  it("normiert den Ladezustand", () => {
    expect(socPercent({ id: "1", name: null, unit: null, value: "0.5" })).toBe(50);
    expect(socPercent({ id: "1", name: null, unit: "%", value: "0.5" })).toBe(0.5);
  });
});

describe("SungrowCloudProvider", () => {
  it("wählt die einzige Anlage und liefert einen Messwert", async () => {
    const { fetchFn } = fakeGateway({
      "/openapi/platform/queryPowerStationList": () => ({ result_code: "1", result_data: { pageList: [{ ps_id: 7 }] } }),
      "/openapi/platform/getPowerStationRealTimeData": (body) => {
        expect(body.ps_id_list).toEqual(["7"]);
        return {
          result_code: "1",
          result_data: { device_point_list: [{ ps_id: 7, p83067: "0", p83106: "500", p83549: "100", p83252: "0.2" }], point_dict: [] },
        };
      },
    });
    const config = testConfig({ ENERGY_PROVIDER: "sungrow-cloud", SUNGROW_APP_KEY: "k", SUNGROW_APP_SECRET: "s" });
    const provider = new SungrowCloudProvider(config, {
      fetch: fetchFn,
      tokenStore: new MemoryTokenStore({ accessToken: "a", refreshToken: "r", expiresAt: Infinity }),
      now: () => new Date("2026-06-21T22:00:00Z"),
    });
    const s = await provider.getCurrentSnapshot();
    expect(s).toMatchObject({ householdPowerW: 500, gridDirection: "import", batteryPowerW: -400, batterySocPercent: 20 });
  });

  it("fragt Gerätepunkte beim passenden Gerät ab", async () => {
    const { fetchFn, calls } = fakeGateway({
      "/openapi/platform/getPowerStationRealTimeData": () => ({
        result_code: "1",
        result_data: { device_point_list: [{ ps_id: 7, p83033: "443", p83106: "187" }], point_dict: [] },
      }),
      "/openapi/platform/getDeviceListByPsId": () => ({
        result_code: "1",
        result_data: {
          pageList: [
            { ps_key: "7_43_2_1", device_type: 43 },
            { ps_key: "7_14_1_1", device_type: 14 },
          ],
        },
      }),
      "/openapi/platform/getDeviceRealTimeData": (body) => ({
        result_code: "1",
        result_data: {
          device_point_list: [
            {
              device_point:
                body.device_type === 14
                  ? { ps_key: "7_14_1_1", p13149: "0", p13121: "0", device_time: "20261101101500" }
                  : { ps_key: "7_43_2_1", p58604: "0.072", device_time: "20261101101000" },
            },
          ],
          point_dict: [],
        },
      }),
    });
    const config = testConfig({
      ENERGY_PROVIDER: "sungrow-cloud",
      SUNGROW_APP_KEY: "k",
      SUNGROW_APP_SECRET: "s",
      SUNGROW_PS_ID: "7",
      SUNGROW_POINT_PV: "83033",
      SUNGROW_POINT_GRID: "14:13149-13121",
      SUNGROW_POINT_SOC: "43:58604",
    });
    const provider = new SungrowCloudProvider(config, {
      fetch: fetchFn,
      tokenStore: new MemoryTokenStore({ accessToken: "a", refreshToken: "r", expiresAt: Infinity }),
      now: () => new Date("2026-11-01T09:20:00Z"),
    });
    const s = await provider.getCurrentSnapshot();
    expect(s).toMatchObject({ pvPowerW: 443, householdPowerW: 187, gridPowerW: 0, batteryPowerW: 256, batterySocPercent: 7.2 });
    // Ältester device_time, 10:10 Ortszeit (MEZ) = 09:10 UTC
    expect(s.timestamp).toBe("2026-11-01T09:10:00.000Z");
    const inverterCall = calls.find((c) => c.body.device_type === 14)!;
    expect(inverterCall.body).toMatchObject({ ps_key_list: ["7_14_1_1"], point_id_list: ["13149", "13121"] });
  });
});

describe("SungrowCloudProvider.getHistory", () => {
  it("fragt in 2-Stunden-Stücken in Ortszeit ab und führt Anlage und Gerät zusammen", async () => {
    const { fetchFn, calls } = fakeGateway({
      "/openapi/platform/getPowerStationPointMinuteDataList": () => ({
        result_code: "1",
        result_data: {
          "7": [
            { time_stamp: "20261101100000", p83033: "1000.0", p83106: "400.0", p83252: "0.5" },
            // Ohne Hausverbrauch nicht verwendbar
            { time_stamp: "20261101100500", p83033: "1000.0", p83106: null, p83252: "0.5" },
          ],
        },
      }),
      "/openapi/platform/getDeviceListByPsId": () => ({
        result_code: "1",
        result_data: { pageList: [{ ps_key: "7_14_1_1", device_type: 14 }] },
      }),
      "/openapi/platform/getDevicePointMinuteDataList": () => ({
        result_code: "1",
        result_data: {
          "7_14_1_1": [
            { time_stamp: "20261101100000", p13149: "0.0", p13121: "100.0" },
            { time_stamp: "20261101100500", p13149: "0.0", p13121: "100.0" },
          ],
        },
      }),
    });
    const config = testConfig({
      ENERGY_PROVIDER: "sungrow-cloud",
      SUNGROW_APP_KEY: "k",
      SUNGROW_APP_SECRET: "s",
      SUNGROW_PS_ID: "7",
      SUNGROW_POINT_PV: "83033",
      SUNGROW_POINT_GRID: "14:13149-13121",
    });
    const provider = new SungrowCloudProvider(config, {
      fetch: fetchFn,
      tokenStore: new MemoryTokenStore({ accessToken: "a", refreshToken: "r", expiresAt: Infinity }),
    });

    // 09:00–12:30 UTC = 10:00–13:30 MEZ → zwei Stücke
    const history = await provider.getHistory(new Date("2026-11-01T09:00:00Z"), new Date("2026-11-01T12:30:00Z"));

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      timestamp: "2026-11-01T09:00:00.000Z",
      pvPowerW: 1000,
      householdPowerW: 400,
      gridDirection: "export",
      gridPowerW: 100,
      batteryPowerW: 500,
      batterySocPercent: 50,
    });
    const plantCalls = calls.filter((c) => c.url.endsWith("getPowerStationPointMinuteDataList"));
    expect(plantCalls.map((c) => [c.body.start_time_stamp, c.body.end_time_stamp])).toEqual([
      ["20261101100000", "20261101120000"],
      ["20261101120000", "20261101133000"],
    ]);
    expect(plantCalls[0]!.body.points).toBe("p83033,p83106,p83252");
  });
});

describe("SungrowCloudProvider Zeitpunkte", () => {
  const plantConfig = () =>
    testConfig({ ENERGY_PROVIDER: "sungrow-cloud", SUNGROW_APP_KEY: "k", SUNGROW_APP_SECRET: "s", SUNGROW_PS_ID: "7" });
  const tokens = () => new MemoryTokenStore({ accessToken: "a", refreshToken: "r", expiresAt: Infinity });

  it("gibt unveränderten Werten ohne device_time keinen neuen Zeitpunkt", async () => {
    let load = "500";
    const { fetchFn } = fakeGateway({
      "/openapi/platform/getPowerStationRealTimeData": () => ({
        result_code: "1",
        result_data: { device_point_list: [{ ps_id: 7, p83067: "0", p83106: load, p83549: "100", p83252: "0.2" }], point_dict: [] },
      }),
    });
    let now = Date.parse("2026-11-01T10:00:00Z");
    const provider = new SungrowCloudProvider(plantConfig(), { fetch: fetchFn, tokenStore: tokens(), now: () => new Date(now) });

    const first = await provider.getCurrentSnapshot();
    now += 5 * 60_000;
    // Cloud liefert dasselbe (z. B. Datenlogger offline): alter Zeitpunkt, wird nicht doppelt gespeichert
    expect((await provider.getCurrentSnapshot()).timestamp).toBe(first.timestamp);
    now += 5 * 60_000;
    load = "510";
    expect((await provider.getCurrentSnapshot()).timestamp).toBe("2026-11-01T10:10:00.000Z");
  });

  it("ordnet die doppelte Stunde bei der Rückstellung auf Winterzeit beiden Zeitpunkten zu", async () => {
    // 25.10.2026: 03:00 MESZ wird zu 02:00 MEZ, 02:30 Ortszeit gibt es zweimal
    const { fetchFn } = fakeGateway({
      "/openapi/platform/getPowerStationRealTimeData": () => ({}),
      "/openapi/platform/getPowerStationPointMinuteDataList": () => ({
        result_code: "1",
        result_data: {
          "7": [
            { time_stamp: "20261025023000", p83067: "0", p83106: "300", p83549: "300", p83252: "0.5" },
            { time_stamp: "20261025023000", p83067: "0", p83106: "400", p83549: "400", p83252: "0.5" },
          ],
        },
      }),
    });
    const provider = new SungrowCloudProvider(plantConfig(), { fetch: fetchFn, tokenStore: tokens() });
    const history = await provider.getHistory(new Date("2026-10-25T00:00:00Z"), new Date("2026-10-25T02:00:00Z"));
    expect(history.map((h) => [h.timestamp, h.householdPowerW])).toEqual([
      ["2026-10-25T00:30:00.000Z", 300],
      ["2026-10-25T01:30:00.000Z", 400],
    ]);
  });
});

describe("OAuth-Routen", () => {
  it("prüft den state und tauscht den Code", async () => {
    const { fetchFn } = fakeGateway({ "/openapi/apiManage/token": () => TOKENS });
    const store = new MemoryTokenStore();
    const app = Fastify();
    registerSungrowOAuth(app, client(fetchFn, store, Date.now));

    const login = await app.inject("/auth/sungrow/login");
    expect(login.statusCode).toBe(302);
    const state = new URL(login.headers.location as string).searchParams.get("state")!;

    expect((await app.inject("/auth/callback?code=x&state=falsch")).statusCode).toBe(400);
    const callback = await app.inject(`/auth/callback?code=x&state=${state}`);
    expect(callback.statusCode).toBe(302);
    expect(await store.load()).not.toBeNull();
    // state ist nur einmal gültig
    expect((await app.inject(`/auth/callback?code=x&state=${state}`)).statusCode).toBe(400);
    await app.close();
  });
});
