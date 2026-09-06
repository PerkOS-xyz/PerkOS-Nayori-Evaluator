# Explicit QA escrow-generation compatibility

## Decision

Keep one evaluator deployment with one explicitly configured contract pair: autonomous STX v5 /
sBTC v4, or earned-service-fee STX v6 / sBTC v5. Preserve the current example/default deployment.
Accepting arbitrary version suffixes would broaden signing authority; replacing the old pair
unconditionally would break existing QA operation. A second service is unnecessary for this
bounded integration. Historical evaluations remain namespaced by network, full contract and job ID.

The configured pair must have valid testnet addresses, the same deployer and matching generations.
The engine validates the exact asset/contract target before inference; the recorder and signing
adapter enforce it independently. The adapter retains only `record-decision`, deny-mode empty
post-conditions, bounded gas and testnet signing. It cannot settle, waive or refund a fee.

## Live job boundary

Before inference and again before recording a decision, read the public testnet network and job.
Require submitted state, the configured evaluator, matching client/provider/description/deadline,
an exact positive funded budget, and a review deadline that has not passed. For fee contracts,
also require initialized 200-basis-point policy, QA windows, job-pinned separate treasury and no
prior service/settlement/waiver. A stale or inconsistent job blocks without signing. Dependency
failure remains retryable only under the existing identical-request/no-artifact/no-tx rules.

These reads are sequential, bounded and signer-free. They are not an atomic chain snapshot; the
contract remains authoritative at execution. Chain changes can still cause a transaction to abort.
Do not claim broadcast acceptance is confirmation or that model agreement is an external audit.
One in-process queue claims jobs serially before using the shared signer. Runtime leases cover
both models, one repair per model and bounded read/nonce/broadcast requests. This requires one QA
replica per signer; it is not a distributed nonce lock. The existing no-blind-retry broadcast
boundary remains unchanged.

## Verification and rollout

Test both generations/assets, unknown/mixed contracts, mismatched evaluator/asset, mainnet input,
stale deadlines, funding/policy inconsistencies, denied adapter calls, and pre/post-inference guards.
Use the packaged SDK candidate separately against existing public QA jobs without publishing or
repeating payments. Real provider/client/LLM E2E follows the reviewed QA merge and coordinated
runtime selection; this change alone does not activate service fees, production or mainnet.

The 2% is earned by evaluated service irrespective of approve/reject, paid only on final settlement.
It is not a reward for a favorable decision. Review-timeout without evaluation still pays 100%
to the provider. Human waiver authority and treasury custody remain independent.
