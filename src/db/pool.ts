import pg from "pg";

const { Pool } = pg;

export function createPool(connectionString: string, max: number): pg.Pool {
  return new Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: false,
  });
}

export async function checkDatabase(pool: pg.Pool): Promise<void> {
  await pool.query("SELECT 1");
}
