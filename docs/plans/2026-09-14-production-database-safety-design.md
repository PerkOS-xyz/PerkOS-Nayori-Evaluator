# Production database safety design

## Context

The Evaluator is a deterministic signing boundary around Hermes/PerkOS-LLM. Stacks is authoritative
for escrow and settlement, but PostgreSQL preserves admission idempotency, leases, model artifacts,
broadcast reconciliation and the operational audit trail. Losing it could duplicate inference cost
or leave an ambiguous transaction without its local context.

The initial schema was created while the service was testnet-only and restricts `network` to
`testnet`. Production support therefore requires a forward-only migration rather than an ad-hoc
manual schema edit or a rewrite of the already-applied initial migration.

## Considered approaches

1. **Let the Evaluator migrate on startup.** Simple, but gives the signer runtime DDL authority and
   couples every Hermes restart to schema mutation.
2. **Use a managed database migration platform.** Strong operationally, but adds a new vendor and
   is unnecessary for the current single-service schema.
3. **Separate migration job and runtime roles.** The selected approach. A short-lived operator job
   owns DDL; the long-running Evaluator gets only the DML privileges it uses.

## Selected architecture

Migration files are immutable, sequential and checksum-pinned in `schema_migrations`. A dedicated
runner acquires a PostgreSQL advisory lock, verifies every previously applied checksum and applies
each new file in its own transaction with lock and statement timeouts. Static policy rejects data-
destructive statements such as `DROP TABLE`, `DROP COLUMN`, `TRUNCATE` and unbounded `DELETE`.
Dropping and replacing a validated constraint is allowed because it does not remove data.

The Evaluator never runs migrations. At startup it verifies that all repository migrations exist in
the database with matching checksums and refuses readiness on drift or an incomplete schema. The
runtime database role receives only `SELECT`, `INSERT` and `UPDATE` on `evaluations`, plus `SELECT`
on migration metadata. It receives no DDL, delete or truncate privilege.

Hermes/PerkOS-LLM remains an HTTP inference dependency. It receives criteria and verified evidence
only; it has neither the database URL nor the Stacks signer. Updating Hermes cannot mount, replace
or migrate the PostgreSQL volume.

## Backup and recovery

Production uses a named external PostgreSQL volume so replacing an Evaluator image cannot delete
data. Before any migration, an operator creates a logical custom-format dump, verifies its catalog,
uploads it to a dedicated S3 prefix with server-side encryption and records its SHA-256. Migration
is blocked unless that backup succeeds. A restore drill downloads a selected object into an
ephemeral PostgreSQL container, restores it and verifies migration metadata plus evaluation counts;
it never connects to or overwrites production.

Database administration, backup credentials and runtime secrets live in separate absolute,
mode-600 files outside Git. The Stacks key is present only in the runtime file. The migration and
backup files must not contain it. Restore credentials are not exposed to Hermes.

## Rollout

Run repository verification first. Provision a dedicated production database and runtime role,
create and upload a pre-migration backup, run the migration job, then verify the schema using the
runtime role. Build the exact reviewed commit on the VPS and start the Evaluator privately with
public admission disabled. Health and readiness must pass before any controlled mainnet canary.
No migration, service start or readiness check authorizes a blockchain transaction.
