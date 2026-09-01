# Nayori Hermes QA runtime design

The autonomous evaluator is split across two hosts. `perkos-cloud-01` runs a dedicated Hermes
profile with a dedicated PerkOS-LLM credential. `perkos-cloud-02` runs the deterministic evaluator,
PostgreSQL and the Stacks testnet signer. Hermes never receives blockchain signing material.

The evaluator sends primary and verifier requests to separate Hermes sessions over an HTTPS path
allowlisted to the evaluator host. Every request is idempotent, non-streaming and must return one
strict JSON object accepted by the corresponding Zod schema. Missing output, malformed JSON, model
disagreement, low confidence or incomplete criterion coverage blocks the evaluation.

Only the internal authenticated processing route can enqueue work. The chain adapter derives and
checks the configured testnet principal at startup and exposes only `record-decision` against the
configured `agentic-commerce-v5` and `sbtc-commerce-v4` contracts. The call records the evidence and
explanation hashes but does not settle escrow; the on-chain appeal window remains authoritative.

QA acceptance requires unit tests, dependency audit, a Hermes health and structured-output smoke,
contract source equality, distinct role keys, successful v5/v4 deployment, and controlled STX and
sBTC E2E receipts. No mainnet, production image, package publication or M2 adoption claim is part of
this rollout.
