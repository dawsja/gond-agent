# Model failure classification and retry ownership

The API client owns one model-request retry budget, including summary requests. It
never replays a completed response or executes partial calls. Five total attempts
use exponential full jitter (2s base, 60s ceiling), with a valid Retry-After minimum
capped at 120s. Stop drops the stream and its pending sleep. The shared
`runner/model-errors.json` policy supplies both retry decisions and public reasons.
Worst-case backoff is bounded at about 4 × 120 seconds per request when a server sends a long Retry-After (excluding request/stream time).

## What the incident record can establish

Previously, RunService discarded every main error message except the exact string
`The model connection dropped 3 times`. That string became class `network`, attempts
3; everything else became class `unknown`, attempts 1. The boolean retryable flag
was copied separately. Therefore `unknown` plus `retryable:false` does not establish
an unknown provider error: any permanent provider/plan error or non-ApiError failure
could produce that record. The original cause cannot be recovered from the supplied
record. The old generic provider fallback actually had `retryable:true`.

The runner also replaced exhausted rate-limit/server/stream failures with the same
three-drops error, losing the real cause even when retries did run. Subscription
stream errors preserved raw codes to allow account effects; normalized class/status
and attempt counts did not survive into terminal worker events.

## Previous mapping and current treatment

Rows are ordered within each classifier. SSE has status zero unless explicitly
provided; generic subscription SSE errors previously passed through the API-key
classifier rather than the subscription HTTP classifier.

| API-key path / condition | Previous code; retryable | Current treatment |
| --- | --- | --- |
| Explicit context code or HTTP 400 context wording, excluding rate/output/quota | context_exceeded; no | Same; separate compaction, not transient retry |
| insufficient_quota / billing_error | provider_quota; no | Same; also HTTP 402 and other explicit quota/billing/credit codes |
| HTTP 401 / authentication_error / invalid_api_key | provider_auth; no | Same |
| HTTP 403 / permission_error | provider_forbidden; no | Same |
| HTTP 404 / model_not_found / not_found_error | provider_model; no | Same |
| HTTP 429 / rate-limit code | provider_rate_limit; yes | Same, after explicit quota/usage checks; Retry-After forwarded |
| HTTP 5xx (including 529), overloaded_error / server_error / api_error | provider_unavailable; yes | Same; also overloaded, preserving HTTP status |
| HTTP 400/422 / invalid_request_error | provider_request; no | Same |
| Other unrecognized provider error | provider_error; yes | No: unknown failures are not proven transient |
| Explicit usage-limit code | Could fall through or be treated as generic 429 | provider_usage_limit; no, validated reset time surfaced |

| ChatGPT-plan path / code (subscription_sharing_ prefix unless stated) | Previous public code; retryable | Current treatment |
| --- | --- | --- |
| usage_limit_exceeded | chatgpt_usage_limit; no | Same, reset metadata retained; no API billing fallback |
| usage_unavailable | chatgpt_usage_unavailable; yes | Same, five-attempt budget |
| user_unavailable | chatgpt_user_unavailable; yes | Same |
| user_not_eligible | chatgpt_not_eligible; no | Same account effect |
| invalid_user | chatgpt_invalid_user; no | Same |
| unsupported_capability | chatgpt_unsupported; no | Same, without echoing provider parameter text |
| route_not_supported | chatgpt_route; no | Same |
| chatpass_v2_scope_not_authorized / chatpass_v2_invalid_authorization_context | chatgpt_not_authorized; no | Same account effect |
| Generic HTTP 401 / 403 | chatgpt_unauthorized / chatgpt_forbidden; no | Same |
| Generic HTTP 429 | chatgpt_rate_limit; yes | Same unless explicit quota/usage limit |
| Generic HTTP 5xx or status zero | chatgpt_unavailable; yes | Permanent context/quota/request codes checked first |
| Generic SSE server_error / overloaded_error / response.failed with those codes | Raw code, providerFailure retry flag; yes | Normalized provider_unavailable; transient only |
| Generic SSE rate limit | Raw code, providerFailure retry flag; yes | Normalized provider_rate_limit |
| Generic SSE context/auth/quota/request | Raw code, providerFailure retry flag; no | Normalized permanent code |
| response.incomplete | Treated as completed (even unknown reason) | max_output_tokens/content_filter retain existing stop handling; server/unknown missing completion retries; unrecognized explicit reasons fail closed |
| SSE event name without data.type | Ignored by Responses parser | Event name used when data.type is absent |
| Stream EOF without completion | truncated; yes | Same, up to five attempts |

| Transport path | Previous treatment | Current treatment |
| --- | --- | --- |
| callUpstream failure before headers, including stall abort | provider_connection; retryable | Same shared policy |
| Upstream AbortError reaching modelResponse directly | stream; retryable | Same; downstream abort is rethrown |
| Upstream failure after headers | stream; retryable | Same |
| Runner request connect/timeout/request/body error | Retried when recognized by reqwest | network, with real attempts retained |
| Runner HTTP-body truncation / EOF | stream; retryable | Same |
| Malformed SSE JSON / other unrecognized error | Nonretryable, later hidden by service | unknown; nonretryable and fixed safe reason |

Only normalized classes and fixed public sentences cross the public failure
boundary. Raw provider messages, parameter text, URLs and credentials are not
failure reasons. Usage links remain in the existing dedicated usage card.

## Publication guard and runtime fixture

The existing failure path does not publish partial work. Tests cover both a fresh
run and a run with an existing PR: no snapshot/import/push/PR mutation, workspace
kept. No publication behavior was changed.

Build `cd runner && cargo build --locked`, then run
`cd api && npm test -- test/runs-local.test.ts`. The two `real worker against local
model` cases launch the actual JSONL binary against a local HTTP model, execute one
workspace write, then return 503 twice before success or five times until failure.
They feed live worker events through RunService polling into SQLite and print
`MODEL_RETRY_RUNTIME` retry sequences and final run records. GitHub/publication and
the Docker transport are mocked; the runner, request retries, sleep, workspace
write, polling and failure persistence are real. Those two cases explicitly skip
when the debug worker has not been built; the remaining guards still run. Rust
fake-clock tests cover Retry-After and immediate cancellation separately.
