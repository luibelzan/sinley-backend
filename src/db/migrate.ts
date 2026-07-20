import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { pool } from "./pool";

const MIGRATIONS_DIR = join(__dirname, "..", "..", "db", "migrations");

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function getAppliedMigrations(): Promise<Set<string>> {
  const { rows } = await pool.query<{ filename: string }>("SELECT filename FROM schema_migrations");
  return new Set(rows.map((r) => r.filename));
}

async function migrate() {
  await ensureMigrationsTable();
  const applied = await getAppliedMigrations();

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // los nombres empiezan por número (001_, 002_...) así que el orden alfabético es el correcto

  const pending = files.filter((f) => !applied.has(f));

  if (pending.length === 0) {
    console.log("No hay migraciones pendientes, el esquema ya está al día.");
    await pool.end();
    return;
  }

  for (const file of pending) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
    const client = await pool.connect();
    try {
      console.log(`Aplicando ${file}...`);
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`${file} aplicada correctamente`);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(`Error aplicando ${file}:`, err);
      process.exitCode = 1;
      break;
    } finally {
      client.release();
    }
  }

  await pool.end();
}

migrate();
