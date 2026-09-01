# Changelog

## Unreleased

### Fixed

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
