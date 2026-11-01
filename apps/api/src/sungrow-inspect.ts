/**
 * Diagnose der Sungrow-Anbindung: listet Anlagen und alle verfügbaren
 * Messpunkte und prüft die konfigurierte Zuordnung an der Energiebilanz.
 *
 *   npm run sungrow:inspect
 *
 * Ausgaben enthalten Anlagendaten – nicht ungeprüft veröffentlichen.
 */
import { loadConfig } from "./config.js";
import { mappingFromConfig, SungrowCloudProvider } from "./energy/sungrow-cloud-provider.js";
import type { RealtimePoint } from "./energy/sungrow/client.js";
import { mapRealtime, powerW } from "./energy/sungrow/mapping.js";

/** Bekannte Messpunkte der Anlagen-Echtzeitdaten (Leistung, SOC) */
const CANDIDATE_POINTS = [
  "83002", "83032", "83033", "83046", "83052", "83067", "83106", "83129", "83232", "83238",
  "83252", "83326", "83328", "83329", "83330", "83334", "83549",
];

const config = loadConfig({ ...process.env, ENERGY_PROVIDER: "sungrow-cloud" });
const provider = new SungrowCloudProvider(config);
const client = provider.client;

if (!(await client.isAuthorized())) {
  console.error(
    `Noch nicht autorisiert. Server mit ENERGY_PROVIDER=sungrow-cloud starten und ` +
      `${new URL("/auth/sungrow/login", config.SUNGROW_REDIRECT_URI)} im Browser öffnen.`,
  );
  process.exit(1);
}

const plants = await client.listPlants();
console.log(`\nAnlagen (${plants.length}):`);
for (const p of plants) console.log(`  ps_id=${p.ps_id}  ${p.ps_name ?? ""}`);

const psId = config.SUNGROW_PS_ID ?? (plants.length === 1 ? String(plants[0]!.ps_id) : undefined);
if (!psId) {
  console.error("\nMehrere Anlagen – SUNGROW_PS_ID setzen und erneut ausführen.");
  process.exit(1);
}

const { points, extra } = await client.realtime(psId, CANDIDATE_POINTS);
console.log(`\nMesspunkte der Anlage ${psId}:`);
console.table(
  [...points.values()].map((p) => ({ id: p.id, name: p.name, value: p.value, unit: p.unit })),
);
if (Object.keys(extra).length > 0) console.log("Weitere Felder:", extra);

const devices = await client.listDevices(psId);
console.log("\nGeräte (Präfix für Gerätepunkte, z. B. SUNGROW_POINT_GRID=14:13149-13121):");
for (const d of devices) console.log(`  device_type=${d.device_type}  ${d.type_name ?? ""}  ${d.ps_key}`);

const mapping = mappingFromConfig(config);
console.log("\nKonfigurierte Zuordnung:", mapping);
try {
  const { points: mapped, measuredAt } = await provider.fetchPoints();
  const snapshot = mapRealtime(mapped, mapping, measuredAt);
  console.log("Ergebnis:", snapshot);
} catch (error) {
  console.error("Zuordnung schlägt fehl:", error instanceof Error ? error.message : error);
}

// Welche Vorzeichen und welcher Batteriepunkt schließen die Bilanz am besten?
const watts = (id: string) => {
  try {
    return powerW(points.get(id), id);
  } catch {
    return null;
  }
};
const pv = watts(mapping.pv);
const load = watts(mapping.load);
const grid = watts(mapping.grid);
if (pv !== null && load !== null && grid !== null) {
  const batteryCandidates = [...points.values()].filter(
    (p: RealtimePoint) => watts(p.id) !== null && ![mapping.pv, mapping.load, mapping.grid].includes(p.id),
  );
  const rows = [];
  for (const gridSign of [1, -1]) {
    for (const b of batteryCandidates) {
      for (const batterySign of [1, -1]) {
        // Quellen = Senken: PV + Netzbezug = Last + Laden
        const residual = pv + gridSign * grid - load - batterySign * watts(b.id)!;
        rows.push({
          SUNGROW_GRID_IMPORT_SIGN: gridSign === 1 ? "positive" : "negative",
          SUNGROW_POINT_BATTERY: b.id,
          SUNGROW_BATTERY_CHARGE_SIGN: batterySign === 1 ? "positive" : "negative",
          name: b.name,
          residualW: Math.round(residual),
        });
      }
    }
  }
  rows.sort((a, b) => Math.abs(a.residualW) - Math.abs(b.residualW));
  console.log("\nBeste Bilanz-Kandidaten (Restfehler nahe 0 W = plausibel):");
  console.table(rows.slice(0, 6));
  console.log(
    "Hinweis: Nur aussagekräftig, wenn gerade Leistung fließt. Bei Sonne und bei Nacht erneut prüfen, " +
      "bevor die Werte in .env übernommen werden.",
  );
}
