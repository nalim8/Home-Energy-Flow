import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { SungrowClient } from "../energy/sungrow/client.js";

/** Gültigkeit eines state-Werts zwischen Login und Callback */
const STATE_TTL_MS = 10 * 60 * 1000;

interface PendingLogin {
  createdAt: number;
  /** Seite, auf die nach erfolgreicher Autorisierung zurückgeleitet wird */
  returnTo: string;
}

/**
 * Authorization-Code-Flow für die iSolarCloud OpenAPI:
 *
 * - GET /auth/sungrow/login leitet zur Freigabeseite von iSolarCloud weiter
 * - GET <Pfad der Redirect URI>, standardmäßig /auth/callback, prüft den state (CSRF-Schutz) und tauscht den Code gegen Tokens
 *
 * Code und Tokens werden weder ausgeliefert noch geloggt.
 */
export function registerSungrowOAuth(app: FastifyInstance, client: SungrowClient, onAuthorized?: () => void) {
  const pending = new Map<string, PendingLogin>();

  app.get("/auth/sungrow/login", async (request, reply) => {
    const now = Date.now();
    for (const [state, login] of pending) {
      if (now - login.createdAt > STATE_TTL_MS) pending.delete(state);
    }
    const state = randomBytes(24).toString("base64url");
    let url: string;
    try {
      url = client.authorizeUrl(state);
    } catch (error) {
      return reply.code(501).send({ error: error instanceof Error ? error.message : String(error) });
    }
    pending.set(state, { createdAt: now, returnTo: sameOriginReferer(request) ?? "/" });
    return reply.redirect(url);
  });

  const callbackQuery = z.object({
    code: z.string().min(1).optional(),
    state: z.string().min(1).optional(),
    error: z.string().optional(),
    error_description: z.string().optional(),
  });

  // Die Route folgt der konfigurierten Redirect URI, damit jede im Portal hinterlegte Adresse funktioniert
  app.get(new URL(client.redirectUri).pathname, async (request, reply) => {
    const query = callbackQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "Ungültige Callback-Parameter" });
    const { code, state, error, error_description } = query.data;

    if (error) return reply.code(400).send({ error: `Autorisierung abgelehnt: ${error_description ?? error}` });
    const login = state ? consumeState(pending, state) : null;
    if (!code || !login) {
      return reply.code(400).send({ error: "Unbekannter oder abgelaufener state – Login neu starten" });
    }

    try {
      await client.exchangeCode(code);
    } catch (exchangeError) {
      request.log.warn({ err: exchangeError }, "Token-Tausch mit iSolarCloud fehlgeschlagen");
      const message = exchangeError instanceof Error ? exchangeError.message : String(exchangeError);
      return reply.code(502).send({ error: `Token-Tausch fehlgeschlagen: ${message}` });
    }
    request.log.info("Sungrow-Autorisierung erfolgreich");
    onAuthorized?.();
    return reply.redirect(login.returnTo);
  });
}

/** Referer nur übernehmen, wenn er zum selben Host gehört – kein offener Redirect */
function sameOriginReferer(request: FastifyRequest): string | null {
  const referer = request.headers.referer;
  if (!referer) return null;
  try {
    const url = new URL(referer);
    return url.host === request.headers.host ? url.toString() : null;
  } catch {
    return null;
  }
}

function consumeState(pending: Map<string, PendingLogin>, received: string): PendingLogin | null {
  for (const [state, login] of pending) {
    const a = Buffer.from(state);
    const b = Buffer.from(received);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      pending.delete(state);
      return Date.now() - login.createdAt <= STATE_TTL_MS ? login : null;
    }
  }
  return null;
}
