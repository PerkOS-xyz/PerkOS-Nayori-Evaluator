# Changelog

## Unreleased

### Next contract generation (live, opt-in)

- Add support for `nayori-escrow-stx` / `nayori-escrow-sbtc`: a read-only job watcher, a
  next-generation eligibility gate that never acts after the review window, and `record-decision`
  with one deterministic evidence hash. The current contracts are unchanged.
- Pin the live deployments of 2026-11-24 in code: testnet `ST3MRPNX0VNWYRSJ07PNTASE5BZ9K5XE57ARZ39DY`
  and mainnet `SP2BM4WCNQM286PFHPGA1BG2YXER0PCG1PKQ5MF1X`, with their treasury and appeal authority.
  A job with other roles is not evaluated.
- Turn the generation on with `NAYORI_NEXT_ENABLED=true` (default `false`). `NAYORI_NEXT_DEPLOYER`
  is now only an optional cross-check that must equal the pinned deployer.
- Accept the generation on mainnet with its own activation,
  `CONFIRM_MAINNET_NEXT_EVALUATOR=enable-record-decision-nayori-escrow-mainnet`, checked by the
  configuration and the signing adapter on top of `CONFIRM_MAINNET_EVALUATOR`.
- `GET /readyz` reports the next deployer and `nextGeneration.mainnetBroadcastEnabled`.

### Production inference classification

- Use the supported PerkOS-LLM `background_report` workload class for asynchronous evaluation in
  both environments instead of sending a QA-specific label that the gateway classified as default.

### Production database safety

- Add an immutable, checksum-pinned, advisory-locked migration runner and keep all DDL authority
  outside the long-running Evaluator process.
- Add the forward-only schema migration that permits the reviewed `testnet` and `mainnet` network
  values without rewriting the already-released initial migration.
- Restrict the runtime role to the exact table and column-level read/write privileges required by
  the service; it receives no schema creation, delete, truncate or migration authority.
- Require an encrypted S3 backup, SHA-256 verification and an isolated ephemeral restore drill
  before the migration gate can run.
- Add a hardened production Compose reference with a private database network and external
  persistent PostgreSQL volume. No production deployment or mainnet transaction is implied.

### Dual-network release boundary

- Add one fail-closed QA/production network matrix: the live QA `ST16...` v6/v5 pair and the
  reviewed mainnet `SP2K...` v6/v5 pair, each pinned to its canonical Hiro API, sBTC token,
  fee policy, windows, treasury and appeal authority.
- Validate network-specific principals and commitments before inference; recheck the selected
  network before nonce lookup, deny-mode signing and broadcast.
- Add production-safe environment documentation while keeping OAuth-to-S3 private evidence
  explicitly QA-only until its complete production boundary is promoted separately.
- Require an explicit mainnet activation acknowledgement in both configuration and the signing
  adapter, and identify the dual-network service as version 0.2.0.
- Expand unit coverage across both networks and crossed environment/API/deployer/principal cases.

### Committed evaluation candidate

- Add default-off asynchronous public admission for exact on-chain client/provider commitments, budget floors, durable daily/queue caps and one automatic attempt per job.
- Verify downloaded evidence bytes from explicit HTTPS origins before inference; bound file count, size, MIME and timeouts. Reject inconsistent criterion/evidence decisions.
- Recover queued work after restart; quarantine interrupted attempts without replaying inference/signatures. Public mode holds a singleton database lock and disables the legacy internal processing route.
- No deployment, contract changes, mainnet enablement or new on-chain E2E evidence is implied.

### Fixed

- Permit a same-ID, byte-equivalent retry only after a dependency-blocked evaluation with no
  artifact or transaction; different IDs for the same job and mutated same-ID requests now return
  explicit HTTP 409 conflicts instead of a generic 503.
- Include the concrete Zod-derived JSON Schema in every Hermes primary and verifier request so
  live models return the exact fail-closed decision contract instead of an unrelated valid JSON
  object.
- Perform at most one isolated, schema-constrained repair when a model returns valid but
  non-conforming JSON; a failed repair remains blocked and cannot reach the chain adapter.

### Added

- QA/testnet-only autonomous evaluation engine with deterministic validation, schema-constrained
  primary inference and independent verification.
- Fail-closed decision artifacts with public explanation, policy/prompt/model provenance and
  SHA-256 evidence/explanation commitments.
- PostgreSQL idempotency, expiring work leases and sanitized public evaluation reads.
- Contract allowlist exposing only `record-decision`; no arbitrary transfer or settlement tool.
- Dedicated Hermes Responses adapter with isolated primary/verifier sessions and strict JSON
  validation.
- Authenticated internal processing route and a Stacks testnet transaction adapter pinned to the
  configured evaluator principal and v5/v4 contract allowlist.

### Security

- Separate Hermes/PerkOS-LLM identity with no access to Stacks signer material.
- Minimal public health/read surface; the only mutation route requires a dedicated service token.
- Signer/address equality is checked at startup and the adapter cannot target mainnet or arbitrary
  contract functions.
