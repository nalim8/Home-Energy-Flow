import type { EnergySnapshot, GridDirection } from "@hef/energy-domain";
import pg from "pg";
import type { EnergyRepository } from "./repository.js";

interface MeasurementRow {
  measured_at: Date;
  source: EnergySnapshot["source"];
  pv_power_w: number;
  household_power_w: number;
  battery_power_w: number;
  battery_soc_percent: number;
  grid_power_w: number;
  grid_direction: GridDirection;
}

const COLUMNS = [
  "measured_at",
  "source",
  "pv_power_w",
  "household_power_w",
  "battery_power_w",
  "battery_soc_percent",
  "grid_power_w",
  "grid_direction",
] as const;

/** Mehrzeilige INSERTs bleiben unter dem Limit von 65 535 Parametern */
const BATCH_SIZE = 1000;

export class PostgresEnergyRepository implements EnergyRepository {
  constructor(private readonly pool: pg.Pool) {}

  static connect(connectionString: string): PostgresEnergyRepository {
    return new PostgresEnergyRepository(new pg.Pool({ connectionString, max: 5 }));
  }

  async insertMany(snapshots: readonly EnergySnapshot[]): Promise<void> {
    for (let i = 0; i < snapshots.length; i += BATCH_SIZE) {
      const batch = snapshots.slice(i, i + BATCH_SIZE);
      const values: unknown[] = [];
      const rows = batch.map((s, row) => {
        values.push(
          s.timestamp,
          s.source,
          s.pvPowerW,
          s.householdPowerW,
          s.batteryPowerW,
          s.batterySocPercent,
          s.gridPowerW,
          s.gridDirection,
        );
        const offset = row * COLUMNS.length;
        return `(${COLUMNS.map((_, col) => `$${offset + col + 1}`).join(", ")})`;
      });
      await this.pool.query(
        `INSERT INTO measurements (${COLUMNS.join(", ")}) VALUES ${rows.join(", ")}
         ON CONFLICT (source, measured_at) DO NOTHING`,
        values,
      );
    }
  }

  async latest(source?: EnergySnapshot["source"]): Promise<EnergySnapshot | null> {
    const { rows } = await this.pool.query<MeasurementRow>(
      `SELECT ${COLUMNS.join(", ")} FROM measurements
       WHERE $1::text IS NULL OR source = $1
       ORDER BY measured_at DESC LIMIT 1`,
      [source ?? null],
    );
    return rows[0] ? toSnapshot(rows[0]) : null;
  }

  async range(start: Date, end: Date, source?: EnergySnapshot["source"]): Promise<EnergySnapshot[]> {
    const { rows } = await this.pool.query<MeasurementRow>(
      `SELECT ${COLUMNS.join(", ")} FROM measurements
       WHERE measured_at >= $1 AND measured_at < $2 AND ($3::text IS NULL OR source = $3)
       ORDER BY measured_at`,
      [start, end, source ?? null],
    );
    return rows.map(toSnapshot);
  }

  async pruneBefore(before: Date): Promise<number> {
    const result = await this.pool.query("DELETE FROM measurements WHERE measured_at < $1", [before]);
    return result.rowCount ?? 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function toSnapshot(row: MeasurementRow): EnergySnapshot {
  return {
    timestamp: row.measured_at.toISOString(),
    pvPowerW: row.pv_power_w,
    householdPowerW: row.household_power_w,
    batteryPowerW: row.battery_power_w,
    batterySocPercent: row.battery_soc_percent,
    gridPowerW: row.grid_power_w,
    gridDirection: row.grid_direction,
    source: row.source,
  };
}
