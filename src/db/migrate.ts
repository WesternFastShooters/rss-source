import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { createPool } from "./pool.js";

const ADVISORY_LOCK_ID = 20_260_811;

function defaultMigrationsDirectory(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const projectRoot = path.resolve(path.dirname(currentFile), "../..");
  return path.join(projectRoot, "migrations");
}

export async function runMigrations(pool: pg.Pool, directory = defaultMigrationsDirectory()): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(directory))
      .filter((file) => /^\d+_.+\.sql$/.test(file))
      .sort((left, right) => left.localeCompare(right));

    for (const file of files) {
      const existing = await client.query<{ exists: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE name = $1) AS exists",
        [file],
      );
      if (existing.rows[0]?.exists === true) continue;

      const sql = await readFile(path.join(directory, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_ID]).catch(() => undefined);
    client.release();
  }
  return applied;
}

async function main(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"]?.trim();
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required");
  }

  const pool = createPool(databaseUrl, 1);
  try {
    const applied = await runMigrations(pool);
    process.stdout.write(`${JSON.stringify({ ok: true, applied })}\n`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
