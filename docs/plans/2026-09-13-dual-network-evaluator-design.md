# Dual-network evaluator release design

## Context

Nayori's evaluator was intentionally testnet-only while the autonomous workflow and private
evidence boundary were validated. The escrow release now has separate reviewed QA and production
deployments. Production support must not turn a single environment variable into authority to sign
against an arbitrary contract.

## Considered approaches

1. **Separate production fork.** This maximizes physical separation but duplicates security logic,
   creates drift and makes fixes difficult to prove equivalent.
2. **Loose environment-driven configuration.** This is operationally simple but lets a typo or
   compromised runtime combine a mainnet signer with a testnet API or unreviewed contract.
3. **One source tree with an exact network matrix.** This preserves a single reviewed implementation
   while allowing only complete, known tuples. This is the selected approach.

## Selected architecture

`STACKS_NETWORK` selects either `testnet` or `mainnet`. A policy table binds that value to the only
accepted environment name, canonical API origin, deployer, STX and sBTC contract IDs, canonical
PoX-5 token, fee policy, review/appeal windows, treasury and appeal authority. Configuration parsing
rejects any partial or crossed combination. Request parsing also validates the corresponding
`ST`/`SP` address family. The evaluation engine, eligibility reader, recorder and signer all carry
the selected network as data; none assumes testnet implicitly.

The signer derives its principal with the selected network and compares it to the configured public
address. Its capability remains one function—`record-decision`—on one of two allowlisted contracts,
with deny-mode post conditions and bounded fees. The network check occurs before nonce lookup.

Mainnet requires the additional non-secret acknowledgement
`CONFIRM_MAINNET_EVALUATOR=enable-record-decision-v6-v5-mainnet`. Configuration validation and the
signing adapter both require the exact value. This prevents a routine environment switch from
silently activating mainnet broadcasts; it is an operational interlock, not authorization by
itself.

## Evidence boundary

Operator-owned public HTTPS evidence works on either network with the existing byte, MIME, digest,
redirect and origin controls. OAuth-to-S3 private evidence remains QA-only because its issuer and
bucket constraints are part of a larger Platform/OAuth/storage release. Mainnet startup rejects
that feature instead of guessing a production bucket or weakening the hostname allowlist.

## Verification and rollout

Tests cover both allowed tuples and reject crossed environment, API, address, deployer, generation,
asset and signer combinations before inference or signing. Eligibility tests validate canonical
sBTC and exact fee policy for both networks, including the 3-block QA and 144-block production
appeal windows. Existing commitment and persistence behavior remains covered.

The exact commit is deployed to QA first. After readiness, restart/lock and controlled STX/sBTC
tests pass, the same tree may be promoted to production with a new dedicated mainnet evaluator
signer that is separately authorized by both contracts. Source merge alone performs no deployment
and no blockchain transaction.
