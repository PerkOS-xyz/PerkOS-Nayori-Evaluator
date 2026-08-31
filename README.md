# PerkOS Nayori Evaluator

Private autonomous evaluation service for Nayori agent-commerce jobs on Stacks.

The first release is intentionally restricted to the isolated Stacks testnet environment. It
accepts structured job evidence internally, runs deterministic validation, asks a primary model
for a schema-validated decision, requires an independent verifier to agree, and only then permits
the allowlisted `record-decision` contract call. Recording a decision cannot move escrow.

## Security boundaries

- PerkOS-LLM is an inference gateway only and never receives Stacks signer material.
- Network and contract configuration accept only testnet `agentic-commerce-v5` and
  `sbtc-commerce-v4` candidates.
- Low confidence, model disagreement, malformed JSON, incomplete criterion coverage and ambiguous
  evidence fail closed without a transaction.
- Public HTTP routes are read-only: minimal health/readiness plus sanitized evaluation state.
- PostgreSQL enforces one evaluation per `(network, contract, job)` and supports expiring leases.
- Raw/private evidence has a ciphertext-only persistence column; public artifacts contain bounded
  explanations and hashes.

## Local verification

```bash
npm ci
npm run verify
npm audit --audit-level=high
```

Copy `.env.example` to an untracked environment file only in the runtime secret boundary. Never
commit wallet keys, PerkOS-LLM credentials, database credentials, evidence or receipts.

Production deployment remains disabled until the full isolated QA lifecycle and release manifest
pass their gates.
