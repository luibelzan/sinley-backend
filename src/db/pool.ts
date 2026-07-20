import { Pool } from "pg";
import { env } from "../config/env";

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on("error", (err) => {
  // Errores en clientes inactivos del pool: no deben tumbar el servidor,
  // pero sí queremos verlos en los logs.
  console.error("Error inesperado en el pool de PostgreSQL", err);
});

export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch (err) {
    console.error("No se pudo conectar a la base de datos", err);
    return false;
  }
}
