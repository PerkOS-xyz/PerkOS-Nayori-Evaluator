import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const readOperation = (name: string) => readFile(new URL(`../ops/${name}`, import.meta.url), "utf8");

describe("production database operations", () => {
  it("requires a verified encrypted off-host backup before migration", async () => {
    const backup = await readOperation("backup-postgres.sh");
    const gate = await readOperation("migrate-with-backup.sh");
    expect(backup).toContain("pg_dump --format=custom");
    expect(backup).toContain("pg_restore --list");
    expect(backup).toContain("--sse AES256");
    expect(backup).toContain("sha256sum");
    expect(gate.indexOf("backup-postgres.sh")).toBeLessThan(gate.indexOf("node dist/migrate.js"));
    expect(gate.indexOf("restore-drill.sh")).toBeLessThan(gate.indexOf("node dist/migrate.js"));
  });

  it("restores only into an isolated ephemeral database", async () => {
    const restore = await readOperation("restore-drill.sh");
    expect(restore).toContain("--tmpfs /var/lib/postgresql/data");
    expect(restore).toContain("--network none");
    expect(restore).toContain("--network \"container:${container}\"");
    expect(restore).not.toContain("DATABASE_BACKUP_URL");
    expect(restore).toContain("restored_count evaluations");
    expect(restore).toContain("restored_count schema_migrations");
  });

  it("keeps PostgreSQL private and data in an external volume", async () => {
    const compose = await readOperation("compose.production.example.yaml");
    expect(compose).not.toContain("ports:");
    expect(compose).toContain("external: true");
    expect(compose).toContain("internal: true");
    expect(compose).toContain("read_only: true");
  });
});
