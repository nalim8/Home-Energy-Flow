import { cp } from "node:fs/promises";
import { defineConfig } from "tsup";

export default defineConfig({
  // Beide Einstiegspunkte liegen direkt in dist/, damit dist/migrations relativ gleich erreichbar ist
  entry: { server: "src/server.ts", migrate: "src/db/migrate.ts" },
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  // Das Domain-Paket liegt als TypeScript-Quelltext vor und wird mitgebündelt.
  noExternal: ["@hef/energy-domain"],
  // SQL-Migrationen liegen neben dem Bundle
  onSuccess: async () => {
    await cp("src/db/migrations", "dist/migrations", { recursive: true });
  },
});
