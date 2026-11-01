import type { PollStatus } from "@hef/energy-domain";
import type { FastifyBaseLogger } from "fastify";
import type { EnergyRepository } from "../db/repository.js";
import type { EnergyProvider } from "./provider.js";
import { energySnapshotSchema } from "./schema.js";

export interface PollerOptions {
  intervalSeconds: number;
  retentionDays: number;
  logger: Pick<FastifyBaseLogger, "info" | "warn" | "error">;
  now?: () => Date;
}

const PRUNE_EVERY_MS = 60 * 60 * 1000;
/** Obergrenze für das Zurückweichen bei wiederholten Fehlern */
const MAX_BACKOFF_FACTOR = 10;

/**
 * Ruft regelmäßig den aktuellen Messwert ab, prüft ihn und speichert ihn.
 * Fehlgeschlagene Abrufe werden nur im Status vermerkt – ein alter Messwert
 * wird nie mit neuem Zeitstempel erneut gespeichert.
 */
export class EnergyPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** pollNow() während eines laufenden Abrufs */
  private pollAgain = false;
  private lastPruneAt = 0;
  private readonly now: () => Date;
  private readonly status: PollStatus = {
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastErrorCode: null,
    consecutiveFailures: 0,
  };

  constructor(
    private readonly provider: EnergyProvider,
    private readonly repository: EnergyRepository,
    private readonly options: PollerOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  getStatus(): PollStatus {
    return { ...this.status };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * Zieht den nächsten Abruf vor, z. B. nach einer Autorisierung; Backoff beginnt neu.
   * Läuft gerade ein Abruf, folgt der nächste direkt danach statt einer zweiten Schleife.
   */
  pollNow(): void {
    if (!this.running) return;
    if (!this.timer) {
      this.pollAgain = true;
      return;
    }
    clearTimeout(this.timer);
    this.timer = null;
    this.status.consecutiveFailures = 0;
    void this.loop();
  }

  /** Ein einzelner Abruf; gibt true zurück, wenn ein Messwert gespeichert wurde. */
  async pollOnce(): Promise<boolean> {
    this.status.lastAttemptAt = this.now().toISOString();
    try {
      const raw = await this.provider.getCurrentSnapshot();
      const parsed = energySnapshotSchema.safeParse(raw);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
        throw new Error(`Ungültiger Messwert vom Provider: ${issues}`);
      }
      await this.repository.insertMany([parsed.data]);
      this.status.lastSuccessAt = this.status.lastAttemptAt;
      this.status.lastError = null;
      this.status.lastErrorCode = null;
      this.status.consecutiveFailures = 0;
    } catch (error) {
      this.status.consecutiveFailures += 1;
      this.status.lastError = error instanceof Error ? error.message : String(error);
      const code = (error as { code?: unknown } | null)?.code;
      this.status.lastErrorCode = typeof code === "string" ? code : null;
      // Nicht bei jedem Fehlversuch loggen, sonst flutet ein Dauerausfall das Log
      if (this.status.consecutiveFailures === 1 || this.status.consecutiveFailures % 20 === 0) {
        this.options.logger.warn(
          { err: error, consecutiveFailures: this.status.consecutiveFailures },
          "Abruf der Energiedaten fehlgeschlagen",
        );
      }
      return false;
    }
    await this.pruneIfDue();
    return true;
  }

  private async pruneIfDue() {
    const now = this.now().getTime();
    if (now - this.lastPruneAt < PRUNE_EVERY_MS) return;
    this.lastPruneAt = now;
    try {
      const removed = await this.repository.pruneBefore(new Date(now - this.options.retentionDays * 86_400_000));
      if (removed > 0) this.options.logger.info({ removed }, "Alte Messwerte gelöscht");
    } catch (error) {
      this.options.logger.error({ err: error }, "Löschen alter Messwerte fehlgeschlagen");
    }
  }

  private async loop(): Promise<void> {
    // Ein gesetzter Timer bedeutet „wartet auf den nächsten Abruf“; während eines Abrufs ist er null
    this.timer = null;
    if (!this.running) return;
    await this.pollOnce();
    if (!this.running) return;
    if (this.pollAgain) {
      this.pollAgain = false;
      this.status.consecutiveFailures = 0;
      return this.loop();
    }
    const factor = Math.min(MAX_BACKOFF_FACTOR, 2 ** Math.max(0, this.status.consecutiveFailures - 1));
    this.timer = setTimeout(() => void this.loop(), this.options.intervalSeconds * 1000 * factor);
  }
}
