# Bounded cached-feed responses and failure diagnostics

The previous HTTP client used a 4,000,000-byte ceiling for both control responses
and complete JSON Feed bodies. HTML-safe JSON escaping can expand `<`, `>`, `&`,
U+2028 and U+2029, so raw cached HTML size is not the response size. A valid feed
with many individually small article bodies can exceed that transport ceiling.

The old catch also replaced response-size, HTTP, JSON, timeout and network
failures with `WECHAT2RSS_REQUEST_FAILED`. The cache synchronization engine then
reported only `unavailable`, hiding the distinction between a missing upstream
cache and a local refusal to read it.

## Limits

| Boundary                                              | Limit                                     |
| ----------------------------------------------------- | ----------------------------------------- |
| `/feed/*.json`, including accepted/listed cache reads | 16 MiB (16,777,216 bytes)                 |
| Control endpoints and XML                             | 4,000,000 bytes, unchanged                |
| One parsed article body                               | 2,000,000 UTF-8 bytes, unchanged          |
| Parsed items per feed                                 | 1,000, unchanged                          |
| Headers plus complete body read                       | One existing deadline, at most 10 seconds |

The cache response ceiling provides room for a multi-article body and JSON
escaping without removing the resource bound. It is fixed, scoped to JSON feed
routes, and not a per-subscription exception. Larger bodies are rejected as a
whole; articles are never silently omitted or truncated. Existing identity,
date, HTML sanitization, per-body and item-count checks remain authoritative.

The reader counts actual bytes emitted by the response stream, including
decompressed output; Content-Length is not trusted. It reuses a 64 KiB byte
buffer, decodes UTF-8 across chunk boundaries, and keeps at most one decoded
string piece per block before joining for JSON parsing. It avoids retaining a
Buffer for every network chunk and avoids a second full-response Buffer copy.
The final text, parsed JSON and sanitized bodies still consume memory; this is
a bounded buffered JSON parser, not an unlimited streaming article importer.

The same abort signal bounds header and body waits. Abort listeners are removed
after each wait, avoiding one retained promise reaction per tiny chunk.
Rejected responses are cancelled. Cancellation failures or a cancellation that
never settles cannot hide the original diagnostic or prolong the request.

## Diagnostics and evidence

Failures retain fixed codes for too-large responses, HTTP status, invalid JSON,
invalid UTF-8, empty body, timeout and network errors. Cache status includes the
safe reason, failure stage, timestamp, and applicable numeric HTTP status or
observed-byte/limit values. Metadata reads and feed read/import failures are
distinguished. A subsequent successful read clears its current failure. URLs,
query tokens, response content, raw exceptions and SQL are not returned.

Offline tests run the pinned old provider against synthetic streams. A valid
24-item HTML-safe serialized feed of exactly 4,003,033 bytes is refused by the
old client and accepted in full by the new client. HTTP 503 and malformed JSON
also prove the old diagnostic collapse. This establishes the failure mechanism;
it does not establish the wire size or original exception of an uncaptured
production response. Renderer field layout and escaping must match before a
reconstructed size can be treated as actual response evidence.

Regressions cover the exact new limit, limit+1, lying length/encoding headers,
non-settling cancellation, header/body timeout, one-byte UTF-8 chunks, unchanged
control/body/item ceilings, and independent cache status recovery. All requests
are synthetic; no refresh, `/add`, original article/image request or full database
snapshot is needed.

Deployment requires an ordinary server build/restart of the reviewed commit.
There is no schema migration, configuration change, queue replay or manual
refresh required by this patch. Any production acceptance should observe the
existing natural cache synchronization and sanitized diagnostics separately;
offline tests alone do not establish production recovery.
