# Production private-evidence reader

The production Evaluator may read only canonical locators under
`https://api.nayori.ai/v1/private-evidence/<uuid>`. Its mode-600, non-symlink credential file must
contain one OAuth client bound to the reviewed mainnet evaluator wallet and exactly
`evidence:read`. The token endpoint is pinned to `https://oauth.nayori.ai/oauth/token`.

Configuration is selected from the exact network policy: QA maps to QA Platform/OAuth/S3 and
mainnet maps to production Platform/OAuth/S3. Crossed tuples, arbitrary origins, arbitrary buckets,
credentials with extra scopes and a wallet other than the configured evaluator fail at startup.
The S3 hostname is pinned per policy; a URL returned by Platform cannot redirect or escape that
bucket.

OAuth is used only to request the Platform download capability. It is never forwarded to S3,
Hermes or PerkOS-LLM. The downloaded bytes remain bounded and must match the committed size,
SHA-256, UTF-8 and media type before inference. Any failure is reported as
`evidence_unavailable_or_invalid` without logging credentials, signed URLs or contents.

Private evidence and public admission are independent. Production launches with
`PRIVATE_EVIDENCE_ENABLED=true` and `PUBLIC_COMMITTED_EVALUATIONS=false`; only the dedicated
internal bearer route may create the first controlled evaluation. The normal chain eligibility
gate and the one-function `record-decision` signer policy remain unchanged.
