# PerkOS Nayori Evaluator

Autonomous evaluation service for Nayori agent-commerce jobs on Stacks. Source is public;
processing remains QA/testnet-only. The existing mode is internal/authenticated; an unreleased,
default-off committed public admission mode is described below.

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
- Public HTTP routes are read-only by default. The optional committed mode admits exact on-chain
  manifests asynchronously; it disables the internal processing route instead of bypassing quotas.
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
does not independently fetch the old internal mode's deliverable contents. Committed mode verifies
bounded downloaded bytes before either model sees them. Model agreement and tests
are not an external security review. See the [design](docs/plans/2026-09-06-service-fee-qa-design.md).

## Committed public admission — unreleased QA candidate

With `PUBLIC_COMMITTED_EVALUATIONS=true`, `POST /v1/evaluations` validates a v1 SDK request
and returns HTTP 202 with its sanitized state. This is admission, not approval or settlement.
The normal request shape gains mandatory `commitmentVersion: "1"` and a deterministic
`evaluationId` from the SDK's `evaluationJobId({ network, contract, jobId })`.
Use SDK `prepareEvaluationJob` before buyer creation and `prepareEvaluationSubmission` before
provider submission. Criteria bind the client-authored description, network, asset, contract and
evaluator. Evidence additionally binds provider, job ID and criteria digest. The deliverable is
36 bytes (`ny1:` + raw SHA-256), within the current contract's 64-byte limit. No new contract is needed.

Any caller may trigger the **already authorized on-chain manifests**. No caller may replace criteria,
replace the provider's evidence, impersonate a wallet or force a decision. A hash is not a signing
credential or evidence of truth. Existing roles, budget/escrow, fee policy, canonical sBTC, deadline
and no-existing-decision checks run at admission and again before/after inference.

Limits default to 10 admitted jobs per UTC day, 5 queued/leased jobs, and minimum escrow of
100000 micro-STX or 1000 satoshis. Quotas and uniqueness are reserved in one PostgreSQL transaction.
One automatic attempt per job: repeats return the same record without new inference or requeue.
Each attempt has two models with at most one schema repair per model. These caps bound work,
not a guaranteed dollar cost or break-even margin; QA token values are not revenue.

The worker drains the durable queue independently of HTTP and acquires a database-session singleton
lock. A second public worker refuses startup; loss of its lock connection stops new work.
Queued work resumes after restart; expired in-progress leases become
`interrupted_attempt_requires_reconciliation`. Artifacts or ambiguous broadcasts are not retried.
Reconcile the exact wallet nonce, transaction history and record manually; never delete the record
to force a duplicate. This does not claim exactly-once network delivery.

Evidence fetching requires operator-owned HTTPS origins in `EVIDENCE_ALLOWED_ORIGINS`:
no credentials, redirects or arbitrary job-selected hosts. Only UTF-8 text/plain/application/json,
up to five files, 8192 bytes each, 16000 bytes total, 15-second fetch deadlines. Actual byte count,
SHA-256 and MIME must match before inference; both models receive the same verified content.
Keep origin DNS and outbound network policy under operator control; an origin allowlist does not
replace egress protection against DNS changes. No HTML execution, tools or code execution occurs.
Model outputs must cover criteria and cite known evidence; an approval cannot contain failed
criteria or empty references. Human appeal rights and existing settlement authority remain unchanged.

Before rollout: test transaction isolation/quotas against real PostgreSQL, singleton/restart/lock-loss
behavior, public reverse-proxy limits and two independent participant wallets through real QA
creation/submission/evaluation/appeal/finalization. Unit/SQL-contract tests are not those deployment
gates. Keep public mode disabled until they pass. No live endpoint, production service, package
publication or new transaction is enabled by this source change.

## QA-first release

`qa` is the protected integration branch and `main` is production. The exact QA commit is built on
the Nayori VPS and must pass database migration, liveness, readiness and retry-semantics checks
before a release branch may target `main`. Merging code does not activate a production evaluator
or authorize any mainnet transaction.

## Private QA evidence

QA private evidence is an additional opt-in path. Set `PRIVATE_EVIDENCE_ENABLED=true`, the exact
`PRIVATE_EVIDENCE_ORIGIN=https://api.qa.nayori.ai`, and an absolute
`PRIVATE_EVIDENCE_OAUTH_CLIENT_FILE`. That mode-600, non-symlink file must be wallet-linked to the
configured evaluator principal and contain exactly the `evidence:read` scope. The evaluator accepts
only canonical Nayori evidence UUID locators, requests a fresh authorized download, fetches only the
dedicated Nayori QA S3 hostname, and rechecks size, SHA-256, UTF-8 and JSON syntax before inference.
OAuth is never forwarded to S3. Credentials, signed URLs and raw evidence are not public outputs or
logs. The feature is disabled by default and does not change contracts.
