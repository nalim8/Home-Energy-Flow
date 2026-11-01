import { readdir, readFile } from "node:fs/promises";
import pg from "pg";

/**
 * Führt noch nicht angewendete SQL-Migrationen in Dateinamen-Reihenfolge aus.
 * Im Bundle liegen die Dateien unter dist/migrations, im Quelltext unter
 * src/db/migrations – jeweils relativ zu dieser Datei bzw. zum Bundle.
 */
export async function migrate(
  connectionString: string,
  log: (message: string) => void = console.log,
  directory = new URL("./migrations/", import.meta.url),
): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    // Verhindert, dass zwei gleichzeitig startende Instanzen dieselbe Migration ausführen
    await client.query("SELECT pg_advisory_lock(727001)");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

    const { rows } = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.name));
    const files = (await readdir(directory)).filter((f) => f.endsWith(".sql")).sort();

    const newlyApplied: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(new URL(file, directory), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} fehlgeschlagen`, { cause: error });
      }
      log(`Migration angewendet: ${file}`);
      newlyApplied.push(file);
    }
    return newlyApplied;
  } finally {
    await client.query("SELECT pg_advisory_unlock(727001)").catch(() => {});
    await client.end();
  }
}
