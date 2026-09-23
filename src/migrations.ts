import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";

export const MIGRATION_LOCK_ID = 7_240_193;

export interface Migration {
  readonly version: string;
  readonly name: string;
  readonly sql: string;
  readonly sha256: string;
}

const forbiddenStatements = [
  /^\s*drop\s+table\b/iu,
  /^\s*alter\s+table\s+\S+\s+drop\s+column\b/iu,
  /^\s*truncate\b/iu,
  /^\s*delete\s+from\b/iu,
  /^\s*alter\s+table\s+\S+\s+alter\s+column\s+\S+\s+type\b/iu,
];

export function defaultMigrationsDirectory(): string {
  return fileURLToPath(new URL("../migrations/", import.meta.url));
}

export function assertForwardOnlySql(name: string, sql: string): void {
  if (!sql.trim()) throw new Error(`Migration ${name} is empty.`);
  const statements = sql.split(";").map(statement => statement.trim()).filter(Boolean);
  const forbidden = forbiddenStatements.find(pattern => statements.some(statement => pattern.test(statement)));
  if (forbidden) throw new Error(`Migration ${name} contains a destructive statement.`);
}

export async function loadMigrations(directory = defaultMigrationsDirectory()): Promise<Migration[]> {
  const names = (await readdir(directory))
    .filter(name => /^\d{3}_[a-z0-9_]+\.sql$/u.test(name))
    .sort();
  if (names.length === 0) throw new Error("No database migrations found.");

  const migrations: Migration[] = [];
  for (const [index, name] of names.entries()) {
    const version = name.slice(0, 3);
    const expected = String(index + 1).padStart(3, "0");
    if (version !== expected) throw new Error(`Migration sequence gap: expected ${expected}, got ${version}.`);
    const sql = await readFile(join(directory, name), "utf8");
    assertForwardOnlySql(name, sql);
    migrations.push({
      version,
      name,
      sql,
      sha256: createHash("sha256").update(sql).digest("hex"),
    });
  }
  return migrations;
}

async function rollback(client: PoolClient): Promise<void> {
  await client.query("rollback").catch(() => undefined);
}

export async function applyMigrations(pool: Pick<Pool, "connect">, migrations: readonly Migration[]): Promise<void> {
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    locked = true;
    await client.query("begin");
    await client.query(`create table if not exists schema_migrations (
      version text primary key,
      name text not null unique,
      sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
      applied_at timestamptz not null default now()
    )`);
    await client.query("commit");

    const applied = await client.query<{ version: string; name: string; sha256: string }>(
      "select version, name, sha256 from schema_migrations order by version"
    );
    const byVersion = new Map(applied.rows.map(row => [row.version, row]));
    for (const row of applied.rows) {
      const migration = migrations.find(candidate => candidate.version === row.version);
      if (!migration || migration.name !== row.name || migration.sha256 !== row.sha256) {
        throw new Error(`Applied migration drift detected at version ${row.version}.`);
      }
    }

    for (const migration of migrations) {
      if (byVersion.has(migration.version)) continue;
      try {
        await client.query("begin");
        await client.query("set local lock_timeout = '5s'");
        await client.query("set local statement_timeout = '60s'");
        await client.query(migration.sql);
        await client.query(
          "insert into schema_migrations (version, name, sha256) values ($1, $2, $3)",
          [migration.version, migration.name, migration.sha256]
        );
        await client.query("commit");
      } catch (error) {
        await rollback(client);
        throw error;
      }
    }
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    if (locked) await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }
}

export async function grantRuntimePrivileges(client: Pick<PoolClient, "query">, role: string): Promise<void> {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(role)) throw new Error("Invalid database runtime role.");
  const quoted = `"${role}"`;
  await client.query(`revoke create on schema public from ${quoted}`);
  await client.query(`grant usage on schema public to ${quoted}`);
  await client.query(`revoke all privileges on all tables in schema public from ${quoted}`);
  await client.query(`revoke all privileges on all sequences in schema public from ${quoted}`);
  await client.query(`grant select on evaluations to ${quoted}`);
  await client.query(`grant insert (id, network, asset, contract_id, job_id, status, request_json) on evaluations to ${quoted}`);
  await client.query(`grant update (status, public_artifact, blocked_reason, txid, lease_owner, lease_expires_at, attempts, updated_at) on evaluations to ${quoted}`);
  await client.query(`grant select on schema_migrations to ${quoted}`);
}

export async function verifyAppliedMigrations(
  pool: Pick<Pool, "query">,
  migrations: readonly Migration[]
): Promise<void> {
  const result = await pool.query<{ version: string; name: string; sha256: string }>(
    "select version, name, sha256 from schema_migrations order by version"
  );
  if (result.rows.length !== migrations.length) throw new Error("Database schema is incomplete.");
  for (const [index, migration] of migrations.entries()) {
    const row = result.rows[index];
    if (!row || row.version !== migration.version || row.name !== migration.name || row.sha256 !== migration.sha256) {
      throw new Error(`Database migration checksum mismatch at ${migration.version}.`);
    }
  }
}
