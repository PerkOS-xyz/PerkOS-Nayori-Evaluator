# Security policy

Report vulnerabilities privately to the PerkOS maintainers. Do not include wallet keys, API keys,
private evidence or personal data in issues, pull requests or logs.

The evaluator is initially restricted to Stacks testnet. Its dedicated Hermes runtime receives
evidence and criteria only; it never receives signer material. The chain adapter exposes only
`record-decision` against an explicit contract allowlist. Approval does not settle escrow and all
ambiguous, low-confidence, malformed or disagreeing model outputs fail closed.

The internal processing route requires a dedicated bearer token and must remain private to the QA
platform boundary. Hermes is hosted separately and its HTTPS route is allowlisted to the evaluator
host. Never reuse the Hermes API token, evaluator API token or testnet signer outside Nayori QA.
