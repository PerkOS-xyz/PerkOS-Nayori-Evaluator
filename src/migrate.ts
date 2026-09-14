import { Pool } from "pg";
import { z } from "zod";
import { applyMigrations, grantRuntimePrivileges, loadMigrations } from "./migrations.js";

const migrationConfig = z.object({
  DATABASE_ADMIN_URL: z.string().url().refine(
    value => value.startsWith("postgres://") || value.startsWith("postgresql://"),
    "DATABASE_ADMIN_URL must use the PostgreSQL protocol."
  ),
  DATABASE_RUNTIME_ROLE: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u),
}).parse(process.env);

const pool = new Pool({ connectionString: migrationConfig.DATABASE_ADMIN_URL, max: 1 });
try {
  const migrations = await loadMigrations();
  await applyMigrations(pool, migrations);
  const client = await pool.connect();
  try {
    await grantRuntimePrivileges(client, migrationConfig.DATABASE_RUNTIME_ROLE);
  } finally {
    client.release();
  }
  console.log(JSON.stringify({
    status: "migrations_applied",
    migrations: migrations.map(({ version, name, sha256 }) => ({ version, name, sha256 })),
    runtimeRole: migrationConfig.DATABASE_RUNTIME_ROLE,
  }));
} finally {
  await pool.end();
}
