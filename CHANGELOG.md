# Changelog

## Unreleased

### Added

- QA/testnet-only autonomous evaluation engine with deterministic validation, schema-constrained
  primary inference and independent verification.
- Fail-closed decision artifacts with public explanation, policy/prompt/model provenance and
  SHA-256 evidence/explanation commitments.
- PostgreSQL idempotency, expiring work leases and sanitized public evaluation reads.
- Contract allowlist exposing only `record-decision`; no arbitrary transfer or settlement tool.

### Security

- Separate PerkOS-LLM identity with no access to Stacks signer material.
- Minimal health surface, no public mutation endpoint and no tracked runtime environment files.
