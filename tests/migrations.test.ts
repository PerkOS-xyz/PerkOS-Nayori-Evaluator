import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  applyMigrations,
  assertForwardOnlySql,
  grantRuntimePrivileges,
  loadMigrations,
  verifyAppliedMigrations,
  type Migration,
} from "../src/migrations.js";

const migration: Migration = {
  version: "001",
  name: "001_safe.sql",
  sql: "create table safe_table (id integer primary key);",
  sha256: "11".repeat(32),
};

describe("database migrations", () => {
  it("loads the repository sequence and the forward-only mainnet constraint", async () => {
    const migrations = await loadMigrations();
    expect(migrations.map(item => item.version)).toEqual(["001", "002"]);
    expect(migrations[1]?.sql).toContain("'mainnet'");
    expect(migrations.every(item => /^[0-9a-f]{64}$/u.test(item.sha256))).toBe(true);
  });

  it.each(["drop table x", "alter table x drop column y", "truncate x", "delete from x"])(
    "rejects destructive SQL: %s",
    sql => expect(() => assertForwardOnlySql("bad.sql", sql)).toThrow("destructive")
  );

  it("rejects sequence gaps", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nayori-migrations-"));
    await writeFile(join(directory, "002_gap.sql"), "create table x (id integer);\n");
    await expect(loadMigrations(directory)).rejects.toThrow("sequence gap");
  });

  it("applies an unapplied migration under a session lock and transaction", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith("select version")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    await applyMigrations({ connect: async () => client } as Pick<Pool, "connect">, [migration]);
    expect(query.mock.calls.some(call => call[0] === migration.sql)).toBe(true);
    expect(query.mock.calls.some(call => call[0].startsWith("insert into schema_migrations"))).toBe(true);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("fails closed when an applied checksum drifts", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith("select version")) {
        return { rows: [{ version: "001", name: migration.name, sha256: "22".repeat(32) }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    await expect(applyMigrations({ connect: async () => client } as Pick<Pool, "connect">, [migration]))
      .rejects.toThrow("drift");
  });

  it("grants only runtime DML and rejects unsafe role identifiers", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    await grantRuntimePrivileges({ query } as unknown as PoolClient, "nayori_evaluator_runtime");
    const statements = query.mock.calls.map(call => call[0]).join("\n");
    expect(statements).toContain("grant select on evaluations");
    expect(statements).toContain("grant insert (id, network, asset");
    expect(statements).toContain("grant update (status, public_artifact");
    expect(statements).toContain("revoke all privileges on all tables");
    expect(statements).not.toContain("grant delete");
    expect(statements).not.toContain("grant truncate");
    await expect(grantRuntimePrivileges({ query } as unknown as PoolClient, "unsafe-role;drop"))
      .rejects.toThrow("Invalid database runtime role");
  });

  it("verifies the exact applied migration set", async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [migration], rowCount: 1 }) };
    await expect(verifyAppliedMigrations(pool as unknown as Pool, [migration])).resolves.toBeUndefined();
    await expect(verifyAppliedMigrations(pool as unknown as Pool, [{ ...migration, sha256: "33".repeat(32) }]))
      .rejects.toThrow("checksum mismatch");
  });
});
