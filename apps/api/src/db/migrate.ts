import { migrate } from "./migrator.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL ist nicht gesetzt");
  process.exit(1);
}

const applied = await migrate(url);
console.log(applied.length > 0 ? `${applied.length} Migration(en) angewendet` : "Datenbank ist aktuell");
