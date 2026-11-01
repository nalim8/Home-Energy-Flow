import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";

/** Ohne Anmeldung erreichbar, damit Docker und Monitoring den Zustand prüfen können */
const PUBLIC_PATHS = new Set(["/api/health"]);

/**
 * Schützt App und API mit HTTP Basic Auth. Der Browser fragt einmal nach dem
 * Passwort und sendet es danach bei jeder Anfrage mit; der Benutzername ist
 * beliebig. Nur zusammen mit HTTPS verlässt das Passwort nicht im Klartext den Rechner.
 */
export function registerPasswordProtection(app: FastifyInstance, password: string) {
  const expected = digest(password);

  app.addHook("onRequest", async (request, reply) => {
    if (PUBLIC_PATHS.has(request.url.split("?")[0]!)) return;
    if (timingSafeEqual(digest(basicPassword(request.headers.authorization)), expected)) return;
    return reply
      .code(401)
      .header("www-authenticate", 'Basic realm="Home Energy Flow", charset="UTF-8"')
      .send({ error: "Anmeldung erforderlich" });
  });
}

/** Passwort aus „Basic base64(user:passwort)“; leer, wenn der Header fehlt oder ungültig ist */
function basicPassword(header: string | undefined): string {
  const match = header ? /^Basic\s+(.+)$/i.exec(header) : null;
  if (!match) return "";
  const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  return separator === -1 ? "" : decoded.slice(separator + 1);
}

// Gleich lange Hashes, damit timingSafeEqual auch bei unterschiedlich langen Passwörtern greift
const digest = (value: string) => createHash("sha256").update(value).digest();
