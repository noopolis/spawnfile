# TypeSafe System One

Owns the explicit paid hosted decision transport, typed wire mapping, request
limits, retries and spend reservations. Public seam: index.ts through decision.
Never read labels or calibration, provision models, or fall back to another route.
Read TYPESAFE_API_KEY only at construction. Never retain headers, raw responses
or native errors in receipts/diagnostics; failures use fixed bounded messages.
Identity pins a versioned model and endpoint; no paid identity probes.
Shared budgets reserve once per send across retries and release on every exit.
Measured usage adds spend; unknown usage remains null in receipts, not a held reservation.
Scoring appends only its own requests to the caller collector before settling;
backend history is diagnostic only, never invocation accounting.
Mint a fresh requestId for each dispatched attempt, including retries. History
and caller collectors retain the same ID; copies never mint new identities.
Verify adjacent mocked tests, cancellation, model drift, batching, redaction and
spend mutations; no live key or network required.

HTTPS only; configured paid prices are positive and zero caps block dispatch even
when floating-point estimates underflow. Each HTTP attempt owns a fresh timeout;
caller cancellation stays terminal. Retry network/timeouts, 408, 429, 499 and 5xx with bounded backoff (408/499 are proxy-side drops of a valid request).
State groups use a pool (default 8, configured 1–32); split batches stay sequential.
Stop admission and drain started work on failure before exposing receipts.
HTTP 402 is a terminal payment error, like 401 authentication failure: never
retry it or return it as missing content. Retain sanitized status-only accounting.
Cancel unread response bodies before retry/return, including authentication errors.
Hosted probabilities have ~0.01 resolution. Normalize complete totals in [0.97, 1.03]
and mark successful results providerRounded; invalid or partial distributions stay missing.

Atomic routes opt into conservativeSpend: every dispatched attempt charges at
least its estimate in the admission ledger, including unknown usage and retries.
Actual receipt usd stays null when usage is unknown. Typed Noul uses true/false labels.

Nonretryable HTTP rejections other than the thrown 401/402 failures return typed
failureCause: request-rejected with status-only reasons. Atomic grading must treat
them as infrastructure errors, never authored missing-content failures.
Local token-limit refusals also return request-rejected, with no dispatched receipt.

Spend-cap admission returns typed failureCause: spend-cap with its sanitized reason, including zero caps and capped retries. No receipt is invented for an undispatched request.
