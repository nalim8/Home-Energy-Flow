import type { FastifyBaseLogger } from "fastify";
import type { EnergyRepository } from "../db/repository.js";
import type { EnergyProvider } from "./provider.js";
import { energySnapshotSchema } from "./schema.js";

export interface BackfillOptions {
  /** Wie weit der regelmäßige Durchlauf zurück nach Lücken sucht */
  days: number;
  /** Ältere Zeiträume werden auch auf Anfrage nicht geladen, weil sie gleich wieder gelöscht würden */
  retentionDays: number;
  /** Abstand zwischen zwei Messwerten, ab dem eine Lücke vorliegt */
  gapSeconds: number;
  /** Jüngster Bereich, den die Quelle noch nicht im Verlauf hat */
  settleSeconds: number;
  /** Abstand, in dem die letzten `days` Tage erneut geprüft werden */
  everyMinutes: number;
  /** Mindestabstand zwischen zwei Portionen */
  stepMinutes: number;
  /** Höchstens so viele Stunden Lücke werden pro Portion nachgeladen */
  maxHoursPerStep: number;
  logger: Pick<FastifyBaseLogger, "info" | "warn" | "error">;
  now?: () => Date;
}

export interface Gap {
  start: Date;
  end: Date;
}

/** Abschnitte, die bei der Abfrage älter waren, liefert die Quelle nicht mehr nach */
const RECHECK_AFTER_MS = 24 * 60 * 60 * 1000;
/** Jüngere Abschnitte ohne Daten werden frühestens nach dieser Zeit erneut abgefragt */
const RETRY_RECENT_MS = 60 * 60 * 1000;
/**
 * Größe der Stücke, die einzeln abgefragt und sofort gespeichert werden. Greift das
 * Abfragelimit mitten im Nachladen, geht so höchstens ein Stück verloren.
 */
const PIECE_MS = 2 * 60 * 60 * 1000;

/**
 * Lücken zwischen aufsteigend sortierten Zeitpunkten im Fenster [from, to].
 * Die Ränder des Fensters zählen mit, damit auch fehlende Tage am Anfang auffallen.
 */
export function findGaps(timestamps: readonly number[], from: number, to: number, gapMs: number): Gap[] {
  const gaps: Gap[] = [];
  let previous = from;
  for (const t of [...timestamps.filter((t) => t > from && t < to), to]) {
    if (t - previous > gapMs) gaps.push({ start: new Date(previous), end: new Date(t) });
    previous = t;
  }
  return gaps;
}

/** Entfernt aus den Lücken alle Abschnitte, die bereits abgefragt wurden. */
export function subtractIntervals(gaps: readonly Gap[], done: readonly Gap[], minMs: number): Gap[] {
  let rest = gaps.map((g) => ({ start: g.start.getTime(), end: g.end.getTime() }));
  for (const d of done) {
    const ds = d.start.getTime();
    const de = d.end.getTime();
    rest = rest.flatMap((g) => {
      if (de <= g.start || ds >= g.end) return [g];
      const parts = [];
      if (ds > g.start) parts.push({ start: g.start, end: ds });
      if (de < g.end) parts.push({ start: de, end: g.end });
      return parts;
    });
  }
  return rest.filter((g) => g.end - g.start > minMs).map((g) => ({ start: new Date(g.start), end: new Date(g.end) }));
}

/** Erkennt das Abfragelimit der Quelle (Sungrow: „er_hour_call_api_times_upper_limit“) */
function isRateLimit(error: unknown): boolean {
  return error instanceof Error && /upper_limit|rate.?limit|too many/i.test(error.message);
}

/**
 * Füllt Lücken in den gespeicherten Messwerten aus dem Verlauf der Quelle, z. B.
 * nach einem Ausfall von Server, Datenbank oder Internet oder wenn ein älterer
 * Zeitraum angezeigt werden soll. Bereits gespeicherte Zeitpunkte bleiben
 * unverändert (eindeutig je Quelle und Zeitpunkt).
 *
 * Die Quelle begrenzt die Abfragen pro Stunde, und der Live-Abruf braucht dieselbe
 * Kontingent. Deshalb wird in Portionen von höchstens `maxHoursPerStep` Stunden
 * nachgeladen, mit mindestens `stepMinutes` Abstand; meldet die Quelle ihr Limit,
 * ruht das Nachladen bis zur nächsten vollen Stunde.
 */
export class EnergyBackfiller {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<number> | null = null;
  /** Noch abzuarbeitender Zeitraum (Vereinigung aller Anfragen) */
  private wanted: { start: number; end: number } | null = null;
  private lastStepAt = -Infinity;
  private lastRegularAt = -Infinity;
  private pausedUntil = 0;
  /** Bereits abgefragte Abschnitte mit Zeitpunkt der Abfrage */
  private attempted: (Gap & { at: number })[] = [];
  private readonly now: () => Date;

  constructor(
    private readonly provider: EnergyProvider,
    private readonly repository: EnergyRepository,
    private readonly options: BackfillOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  get supported(): boolean {
    return typeof this.provider.getHistory === "function";
  }

  /** true, solange noch nachzuladende Zeiträume offen sind */
  get busy(): boolean {
    return this.running !== null || this.wanted !== null;
  }

  start(): void {
    if (!this.supported || this.timer) return;
    const tick = () => {
      const now = this.now().getTime();
      if (this.options.days > 0 && now - this.lastRegularAt >= this.options.everyMinutes * 60_000) {
        this.lastRegularAt = now;
        this.enqueue(new Date(now - this.options.days * 86_400_000), new Date(now));
      }
      void this.step();
      this.timer = setTimeout(tick, this.options.stepMinutes * 60_000);
    };
    // Kurz warten, damit der erste Live-Abruf Vorrang hat
    this.timer = setTimeout(tick, 10_000);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Regelmäßiger Durchlauf über die letzten `days` Tage */
  run(): Promise<number> {
    const now = this.now().getTime();
    return this.request(new Date(now - this.options.days * 86_400_000), new Date(now));
  }

  /**
   * Merkt den Zeitraum zum Nachladen vor und arbeitet sofort eine Portion ab, sofern
   * die letzte lange genug her ist. Gibt die Anzahl nachgeladener Messwerte zurück.
   */
  request(start: Date, end: Date): Promise<number> {
    if (!this.supported) return Promise.resolve(0);
    this.enqueue(start, end);
    if (this.now().getTime() - this.lastStepAt < this.options.stepMinutes * 60_000) return this.running ?? Promise.resolve(0);
    return this.step();
  }

  private enqueue(start: Date, end: Date) {
    const s = start.getTime();
    const e = end.getTime();
    this.wanted = this.wanted ? { start: Math.min(this.wanted.start, s), end: Math.max(this.wanted.end, e) } : { start: s, end: e };
  }

  private step(): Promise<number> {
    const wanted = this.wanted;
    if (!wanted || this.now().getTime() < this.pausedUntil) return this.running ?? Promise.resolve(0);
    this.running ??= (async () => {
      this.lastStepAt = this.now().getTime();
      const { inserted, done } = await this.fill(new Date(wanted.start), new Date(wanted.end));
      // Während des Durchlaufs angefragte Zeiträume bleiben vorgemerkt
      if (done && this.wanted === wanted) this.wanted = null;
      return inserted;
    })().finally(() => (this.running = null));
    return this.running;
  }

  private async fill(start: Date, end: Date): Promise<{ inserted: number; done: boolean }> {
    const now = this.now().getTime();
    const from = Math.max(start.getTime(), now - this.options.retentionDays * 86_400_000);
    const to = Math.min(end.getTime(), now - this.options.settleSeconds * 1000);
    if (from >= to) return { inserted: 0, done: true };

    const gapMs = this.options.gapSeconds * 1000;
    let inserted = 0;
    let gapCount = 0;
    let done = true;
    try {
      const stored = await this.repository.range(new Date(from), new Date(to), this.provider.source);
      const gaps = subtractIntervals(
        findGaps(stored.map((s) => Date.parse(s.timestamp)), from, to, gapMs),
        this.skipped(now),
        gapMs,
      );
      gapCount = gaps.length;

      // Jüngste Lücken zuerst, sie sind meist gefragter
      let budgetMs = this.options.maxHoursPerStep * 3_600_000;
      pieces: for (const gap of gaps.reverse()) {
        for (let pieceEnd = gap.end.getTime(); pieceEnd > gap.start.getTime(); pieceEnd -= PIECE_MS) {
          if (budgetMs <= 0) {
            done = false;
            break pieces;
          }
          const piece = { start: new Date(Math.max(gap.start.getTime(), pieceEnd - PIECE_MS)), end: new Date(pieceEnd) };
          budgetMs -= piece.end.getTime() - piece.start.getTime();

          const history = await this.provider.getHistory!(piece.start, piece.end);
          const valid = history.filter((s) => energySnapshotSchema.safeParse(s).success);
          await this.repository.insertMany(valid);
          inserted += valid.length;
          this.attempted.push({ ...piece, at: now });
        }
      }
    } catch (error) {
      done = false;
      if (isRateLimit(error)) {
        // Bis zur nächsten vollen Stunde warten, dann hat die Quelle das Kontingent erneuert
        this.pausedUntil = Math.ceil((now + 1) / 3_600_000) * 3_600_000 + 2 * 60_000;
        this.options.logger.warn(
          { pausedUntil: new Date(this.pausedUntil).toISOString() },
          "Abfragelimit der Quelle erreicht, Nachladen pausiert",
        );
      } else if ((error as { code?: unknown } | null)?.code === "auth_required") {
        // Ohne Anmeldung ist das erwartbar; der Poller meldet es bereits
        done = true;
      } else {
        this.options.logger.warn({ err: error, gaps: gapCount }, "Nachladen des Verlaufs fehlgeschlagen");
      }
    }
    if (inserted > 0) this.options.logger.info({ inserted, gaps: gapCount, done }, "Lücken aus dem Verlauf gefüllt");
    return { inserted, done };
  }

  /**
   * Abschnitte, die nicht erneut abgefragt werden: was bei der Abfrage schon alt war,
   * liefert die Quelle nicht mehr nach (z. B. vor der Inbetriebnahme); jüngere Abschnitte
   * ohne Daten (z. B. Datenlogger offline) erst nach einer Stunde wieder.
   */
  private skipped(now: number): Gap[] {
    this.attempted = this.attempted.filter((a) => a.end.getTime() < a.at - RECHECK_AFTER_MS || now - a.at < RETRY_RECENT_MS);
    return this.attempted;
  }
}
