# Blocked evaluation retry design

## Context

The evaluator stores one row per `(network, contract, job)` and treats `evaluationId` as the
idempotency identity. The first live QA attempt correctly failed closed before producing an
artifact or transaction. A subsequent request with a new UUID hit the job uniqueness constraint;
the insert was ignored, the new UUID could not be claimed, and the internal endpoint returned a
generic 503. An operator could safely requeue the original row, but the product must express that
transition itself.

## Decision

Retry only the same `evaluationId`, with the byte-equivalent JSON request, when the existing row is
`blocked` specifically by `evaluation_dependency_failure`, has no public artifact, and has no
transaction ID. The retry clears the blocked reason and expired lease fields, returns the row to
`queued`, and preserves the attempt counter; the normal claim increments that counter. This keeps
the original audit identity and prevents a caller from mutating job facts under an existing UUID.

A different UUID for an already-known job is a conflict, not a dependency failure. The authenticated
internal endpoint returns HTTP 409 with a bounded machine reason. A same-UUID request that is
completed, leased, deterministically blocked, decision-ready, broadcast, confirmed, or
`broadcast_failed` also returns 409. `broadcast_failed` must eventually retry the stored artifact,
not invoke the models again, so it is intentionally outside this change.

## Verification

Unit tests cover the guarded requeue SQL path, different-ID conflict, non-retryable status, and HTTP
409 mapping. Existing coordinator, schema, inference, build, and npm audit gates remain mandatory.
The QA rollout will use the exact merge SHA, and a controlled same-ID dependency failure/retry will
be verified without mainnet, production, or npm publication.
