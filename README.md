# PerkOS Nayori Evaluator

Autonomous, fail-closed evaluation service for Nayori agent-commerce jobs on Stacks. It validates
the submitted job and evidence, obtains a schema-constrained decision from a primary model, requires
an independent verifier to agree, and then exposes only the allowlisted `record-decision` contract
call. Recording a decision does not settle or move escrow.

The same reviewed source supports QA and production. Environment selection is explicit and the
complete release tuple is pinned in code; arbitrary deployers, mixed networks and mixed contract
generations fail during startup.

## Release matrix

| Environment | Network | STX escrow | sBTC escrow | API |
| --- | --- | --- | --- | --- |
| QA | Stacks testnet | `ST16EWRC01S1SFWGBP63MW47VY8P3AYFA8VGEBGE5.agentic-commerce-v6` | `ST16EWRC01S1SFWGBP63MW47VY8P3AYFA8VGEBGE5.sbtc-commerce-v5` | `https://api.testnet.hiro.so` |
| Production | Stacks mainnet | `SP2K7PV5NXBNRV510S6DCA6RFMTFHAF3ZPK6ZSXPH.agentic-commerce-v6` | `SP2K7PV5NXBNRV510S6DCA6RFMTFHAF3ZPK6ZSXPH.sbtc-commerce-v5` | `https://api.hiro.so` |

Both environments require the configured 2% earned-service-fee policy, a 12 Bitcoin burn-block
review window and the canonical PoX-5 sBTC token. QA pins its three-block appeal window and isolated
testnet treasury/authority. Production pins the 144-block appeal window, treasury
`SP1NT1V4X6GQR6T32Z8MSMNECZ6GSWX9HZ81SM1Y8`, and appeal authority
`SP2R584GC8W2A921080TY8CQ8P1GZ6JNXYXS65DA6`. The reviewed production evaluator is
`SP3GRG5CKEFNYM5BV0NPPHCM51FT176JQ02QWQ9T3`.

## Security boundaries

- `EVALUATOR_ENV`, `STACKS_NETWORK`, both contract IDs and `STACKS_API_URL` must match one exact row
  of the release matrix. Crossed values stop startup.
- Mainnet additionally requires `CONFIRM_MAINNET_EVALUATOR=enable-record-decision-v6-v5-mainnet`.
  The configuration parser and signing adapter enforce it independently; QA does not require it.
- The configured private key must derive exactly to `EVALUATOR_PRINCIPAL` for the selected network.
- The signer adapter permits only `record-decision`, only for the two selected contracts, with
  deny-mode post conditions and a bounded transaction fee.
- Request principals must use the selected network's address family. Asset, contract and network
  are checked before inference and again before nonce lookup or signing.
- Public chain reads validate job status, roles, description, review deadline, positive exact
  escrow, no prior decision, canonical sBTC and the exact service-fee policy.
- Low confidence, model disagreement, malformed output, incomplete criterion coverage, changed
  commitments and ambiguous network failures all fail closed without retrying a transaction.
- The evaluator cannot finalize a decision, settle escrow, waive/refund fees, resolve appeals or
  sign as the treasury.
- PostgreSQL enforces one evaluation per `(network, contract, job)` and a single worker per signer.
  Ambiguous broadcasts require manual nonce and transaction reconciliation.
- Hermes/PerkOS-LLM receives criteria and verified evidence only. It never receives wallet keys,
  API bearer tokens, OAuth secrets or database credentials.

## Runtime configuration

Use `.env.example` as the QA schema and the production block below as its documented counterpart.
Copy values to an external mode-600 secret file or the runtime secret manager; never commit a
second environment file or populated values.

QA selects:

```dotenv
EVALUATOR_ENV=qa
STACKS_NETWORK=testnet
STX_COMMERCE_CONTRACT=ST16EWRC01S1SFWGBP63MW47VY8P3AYFA8VGEBGE5.agentic-commerce-v6
SBTC_COMMERCE_CONTRACT=ST16EWRC01S1SFWGBP63MW47VY8P3AYFA8VGEBGE5.sbtc-commerce-v5
STACKS_API_URL=https://api.testnet.hiro.so
```

Production selects:

```dotenv
EVALUATOR_ENV=production
STACKS_NETWORK=mainnet
STX_COMMERCE_CONTRACT=SP2K7PV5NXBNRV510S6DCA6RFMTFHAF3ZPK6ZSXPH.agentic-commerce-v6
SBTC_COMMERCE_CONTRACT=SP2K7PV5NXBNRV510S6DCA6RFMTFHAF3ZPK6ZSXPH.sbtc-commerce-v5
STACKS_API_URL=https://api.hiro.so
EVALUATOR_PRINCIPAL=SP3GRG5CKEFNYM5BV0NPPHCM51FT176JQ02QWQ9T3
CONFIRM_MAINNET_EVALUATOR=enable-record-decision-v6-v5-mainnet
```

Before either service can start, its dedicated evaluator address must be authorized by both selected
contracts and its signer must have enough STX for transaction fees. QA and production must use
different signer keys and service credentials. The deployer and treasury keys are not evaluator
credentials and must never be installed in this service.

`GET /readyz` returns only safe configuration metadata, including environment, network, contracts,
generation, fee basis points, evaluator principal and the boolean `mainnetBroadcastEnabled`. It
does not expose the configured confirmation or credentials and is not evidence that a contract
transaction succeeded.

## Evaluation flow

1. Parse the strict request and verify network-specific principals and contract syntax.
2. Check the exact asset/network/contract/evaluator allowlist before model inference.
3. Read the authoritative job, escrow, decision, token and fee policy from Stacks.
4. For committed requests, verify client criteria and provider evidence commitments and download
   only bounded, hash-matching UTF-8 evidence from operator allowlisted HTTPS origins.
5. Run the primary model and one independent verifier with strict schemas and bounded repair.
6. Repeat the chain eligibility gate to catch deadline or state changes.
7. Build and broadcast one `record-decision` transaction. Persist `broadcast_failed` rather than
   claiming success when delivery is ambiguous.

The contract remains authoritative throughout. A decision artifact is not settlement evidence.

## HTTP modes

The default internal mode enables `POST /internal/v1/evaluations` behind a dedicated bearer token.
With `PUBLIC_COMMITTED_EVALUATIONS=true`, that route is disabled and `POST /v1/evaluations` admits
only a v1 deterministic commitment generated from the Nayori SDK. Admission returns HTTP 202; it is
not approval, settlement or a wallet authorization.

Committed mode defaults to 10 admitted jobs per UTC day, five queued/leased jobs, and minimum escrow
of 100000 micro-STX or 1000 satoshis. One automatic attempt is permitted per job. Queued work
survives restart; interrupted attempts are quarantined as
`interrupted_attempt_requires_reconciliation` and are never replayed automatically.

Evidence downloads allow at most five files, 8192 bytes each and 16000 bytes total. Only
`text/plain` and `application/json` are accepted. Redirects, credentials in URLs, HTML, arbitrary
hosts, mismatched MIME, size or SHA-256, and invalid UTF-8 are rejected before inference.

### Private evidence

The OAuth-to-S3 private-evidence reader remains QA-only. It requires
`PRIVATE_EVIDENCE_ORIGIN=https://api.qa.nayori.ai` and an absolute, mode-600, non-symlink OAuth
client file linked to the QA evaluator wallet with exactly `evidence:read`. Mainnet rejects
`PRIVATE_EVIDENCE_ENABLED=true` until Platform, OAuth and the production S3 boundary are promoted
and reviewed together. Production can use explicitly allowlisted public HTTPS evidence origins in
the meantime.

## Verification

```bash
npm ci
npm run verify
npm audit --audit-level=high
```

The repository's tests cover both valid release tuples, all crossed network/deployer/API/principal
combinations, signer isolation, exact chain policies, canonical sBTC, request commitments and
failure semantics. They do not replace a controlled QA rollout, a production canary or an external
security review.

## Release process

`qa` is the integration branch and `main` is production. Build the exact QA commit on the Nayori VPS,
then validate database migration, liveness, readiness, restart/lock behavior and controlled STX and
sBTC lifecycles. Promote the same reviewed tree to `main`; create the production evaluator signer
and runtime configuration separately. Merging this source does not deploy a service or authorize a
mainnet transaction.

See [the dual-network design](docs/plans/2026-09-13-dual-network-evaluator-design.md) and
[SECURITY.md](SECURITY.md).
