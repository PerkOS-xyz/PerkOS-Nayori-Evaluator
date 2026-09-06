# PerkOS Nayori Evaluator

Autonomous evaluation service for Nayori agent-commerce jobs on Stacks. Source is public;
processing remains internal, authenticated and QA/testnet-only.

The first release is intentionally restricted to the isolated Stacks testnet environment. It
accepts structured job evidence internally, runs deterministic validation, asks a primary model
for a schema-validated decision, requires an independent verifier to agree, and only then permits
the allowlisted `record-decision` contract call. Recording a decision cannot move escrow.

## Security boundaries

- Hermes runs on the dedicated PerkOS agent host and is reachable only from the QA evaluator host.
- PerkOS-LLM is consumed only by Hermes and never receives Stacks signer material.
- The evaluator signer remains on the isolated QA platform host and can call only the allowlisted
  `record-decision` function on the explicitly configured testnet contract pair.
- Select autonomous STX v5/sBTC v4 or earned-service-fee STX v6/sBTC v5 under one valid testnet
  deployer. Mixed generations and arbitrary contracts are rejected; examples retain v5/v4.
- Full contract/asset/evaluator checks occur before inference. Public chain reads before and after
  inference verify the submitted job, roles, description, review deadline and exact positive escrow.
  Fee candidates additionally require initialized 2% policy, QA windows, separate pinned treasury,
  canonical sBTC and no existing service/settlement/waiver. Stale jobs cannot earn a decision fee.
- Low confidence, model disagreement, malformed JSON, incomplete criterion coverage and ambiguous
  evidence fail closed without a transaction.
- A validated model artifact is recorded as `decision_ready`; a failed chain submission becomes
  `broadcast_failed`, preserving the hashes without claiming that an on-chain decision exists.
- Public HTTP routes are read-only: minimal health/readiness plus sanitized evaluation state. The
  processing route is internal and requires a dedicated bearer token.
- PostgreSQL enforces one evaluation per `(network, contract, job)` and supports expiring leases.
- One QA worker serializes evaluation/signing to avoid concurrent nonce use in this process.
  The lease covers both models, their bounded repairs and chain checks. Run one replica per signer;
  this is not distributed nonce coordination or a guarantee of exactly-once broadcast.
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

## Earned-service-fee QA integration

After review and merge, select the pair explicitly in the external QA configuration:

```dotenv
STACKS_NETWORK=testnet
STX_COMMERCE_CONTRACT=ST16EWRC01S1SFWGBP63MW47VY8P3AYFA8VGEBGE5.agentic-commerce-v6
SBTC_COMMERCE_CONTRACT=ST16EWRC01S1SFWGBP63MW47VY8P3AYFA8VGEBGE5.sbtc-commerce-v5
STACKS_API_URL=https://api.testnet.hiro.so
```

Keep the existing dedicated evaluator principal/signer, internal credentials and human authority
separate. `/readyz` reports the selected `commerceGeneration` and `earnedServiceFeeBps`; that is
configuration evidence, not a confirmed charge. For v6/v5, `record-decision` attests an evaluated
service and earns the fixed 2% regardless of approve/reject. It **does not transfer money**.
The contract splits funds only at final settlement. This evaluator cannot finalize, waive a fee,
refund it, sign for the treasury or resolve an appeal. No extra appeal fee is introduced.

The compatibility change does not switch the running service or application, publish the SDK,
replace contracts or enable mainnet. After coordinated QA selection, test real buyer/provider
SDK workflows with the actual evaluator before production promotion. Existing evaluations remain
readable by their original contract-qualified identities. All controlled QA actors are internal,
not external adoption or production revenue.

Public reads are paced at three-second intervals and use bounded HTTPS requests to the canonical
testnet API. State can change after a read; the contract remains authoritative. Evidence URIs and
acceptance criteria remain untrusted input under the existing model policy; chain preflight does
not independently fetch or authenticate the deliverable's contents. Model agreement and tests
are not an external security review. See the [design](docs/plans/2026-09-06-service-fee-qa-design.md).

## QA-first release

`qa` is the protected integration branch and `main` is production. The exact QA commit is built on
the Nayori VPS and must pass database migration, liveness, readiness and retry-semantics checks
before a release branch may target `main`. Merging code does not activate a production evaluator
or authorize any mainnet transaction.
