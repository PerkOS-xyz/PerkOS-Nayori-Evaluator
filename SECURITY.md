# Security policy

Report vulnerabilities privately to the PerkOS maintainers. Do not include wallet keys, API keys,
OAuth credentials, private evidence, signed URLs, database contents or personal data in issues,
pull requests or logs.

The evaluator uses one fail-closed source tree with two exact release tuples: QA on Stacks testnet
and production on Stacks mainnet. Environment, network, canonical API, deployer and both contract
names must match. A crossed or unreviewed combination stops startup. The signing adapter exposes
only `record-decision`; it cannot transfer funds, settle escrow, waive or refund fees, or resolve an
appeal.

Use a dedicated signer and independent service credentials for each environment. Never install the
deployer, treasury or appeal-authority key in this service, and never reuse the QA signer in
production. Store runtime secrets outside Git with mode 600 or an equivalent secret manager.

Hermes receives evidence and criteria only and must not receive any Stacks signer or service secret.
The default internal mutation route must remain behind the private service boundary. Public
committed admission is opt-in, quota bounded and cannot authorize wallet spending.

Private OAuth-to-S3 evidence is deliberately QA-only. Mainnet configuration fails if that feature
is enabled before the production Platform/OAuth/storage boundary is separately promoted and
reviewed. Public HTTPS evidence remains subject to the explicit origin allowlist, byte/MIME/hash
limits and no-redirect policy.

An ambiguous broadcast is not retried automatically. Reconcile the exact evaluator nonce and
transaction history before any operator action.
