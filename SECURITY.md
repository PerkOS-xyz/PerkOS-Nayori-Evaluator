# Security policy

Report vulnerabilities privately to the PerkOS maintainers. Do not include wallet keys, API keys,
OAuth credentials, private evidence, signed URLs, database contents or personal data in issues,
pull requests or logs.

The evaluator uses one fail-closed source tree with two exact release tuples: QA on Stacks testnet
and production on Stacks mainnet. Environment, network, canonical API, deployer and both contract
names must match. A crossed or unreviewed combination stops startup. The signing adapter exposes
only `record-decision`; it cannot transfer funds, settle escrow, waive or refund fees, or resolve an
appeal.

Mainnet also requires the exact non-secret activation acknowledgement
`CONFIRM_MAINNET_EVALUATOR=enable-record-decision-v6-v5-mainnet`. It is enforced by configuration
and again by the signing adapter. Its presence does not replace signer isolation, authorization,
funding checks or a controlled release.

Use a dedicated signer and independent service credentials for each environment. Never install the
deployer, treasury or appeal-authority key in this service, and never reuse the QA signer in
production. Store runtime secrets outside Git with mode 600 or an equivalent secret manager.

The runtime database role has no DDL, delete or truncate capability. Migrations run only through a
separate administrative job after an off-host backup succeeds. Applied migration names and SHA-256
digests are immutable; drift or an incomplete schema prevents Evaluator startup. Hermes has no
database credential or volume access, so an inference-runtime update cannot migrate or delete data.
The migration gate also restores every pre-migration dump into a disposable, network-isolated
PostgreSQL instance and compares the evaluation and migration row counts before allowing DDL.

Hermes receives evidence and criteria only and must not receive any Stacks signer or service secret.
The default internal mutation route must remain behind the private service boundary. Public
committed admission is opt-in, quota bounded and cannot authorize wallet spending.

Private OAuth-to-S3 evidence is deliberately QA-only. Mainnet configuration fails if that feature
is enabled before the production Platform/OAuth/storage boundary is separately promoted and
reviewed. Public HTTPS evidence remains subject to the explicit origin allowlist, byte/MIME/hash
limits and no-redirect policy.

An ambiguous broadcast is not retried automatically. Reconcile the exact evaluator nonce and
transaction history before any operator action.
