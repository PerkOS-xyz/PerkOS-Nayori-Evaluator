# Private evidence reader for the QA evaluator

The evaluator recognizes only the canonical `https://api.qa.nayori.ai/v1/private-evidence/<uuid>`
locator. It obtains a short-lived OAuth token from a wallet-linked, read-only evaluator client,
posts the UUID to Nayori, fetches the returned at-most-60-second S3 capability without forwarding
OAuth, then verifies exact size, SHA-256, UTF-8 and JSON syntax before inference.

The client credential lives in an absolute, regular, non-symlink mode-600 file outside Git. It must
be bound to the configured evaluator principal and exactly the `evidence:read` scope. Configuration
is fail-closed and disabled by default. URLs, credentials and evidence contents are never logged or
included in public evaluation output. Public allowlisted HTTPS evidence remains supported.
