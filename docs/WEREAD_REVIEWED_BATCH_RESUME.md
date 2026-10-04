# Reviewed continuation of a saved manual batch

The normal-session validation obtained a directory and three body responses,
then stopped at a local publication-time contract error. The time-source repair
now verifies all three saved bodies without changing their original timestamps.
The continuation reuses these exact responses through the original local manual
refresh path, rather than requesting the directory or successful bodies again.
It does not convert a platform refusal into collection permission.

`activateReviewedWereadBatch` is an integration-only utility, not an HTTP
mutation. It requires explicit review, exact config/session/state hashes, the
original batch's immutable cache manifest, the same human login/index and the
specific third-body local conflict. It verifies every response byte hash,
publisher, canonical identity, title and independent body publication time.
It rejects unrelated stops and stale evidence, creates a consistent verified
SQLite backup, and updates private session/binding authorization under the
existing login and collection locks. Before-images preserve both previous stops
and authorizations. A failed config commit rolls back the state only when the
config is provably unchanged. Human QR time, account token and index stay intact.

The original provider verifies the cache again before reserving the continuation.
Only local manual refresh may use it. It preserves the original batch timestamp
and response sequence, starts with the three verified bodies, then requests
body positions 4–10 and uses the existing image archive and protected save.
Reservation consumes the initial continuation before any new request; an
interrupted incomplete batch cannot replay it. A new refusal changes the stop
and immediately invalidates continuation. Only ten verified bodies and the
successful existing image archive enable subsequent local manual refreshes;
these read the live directory again and remain subject to cooldown and expiry.
Directory time remains ordering metadata, while saved publication time comes
from the internally consistent original body fields. Existing trusted article
times and data protections are unchanged.

Normal Web maintenance can use the same account's still-valid refresh cookie
after the short-lived key expires. The existing fixed HTTPS renewal helper sends
only unexpired cookies and requires a live matching VID and refresh credential;
it never transmits an expired key or modifies its expiry. Historical snapshot
validation retains the real prior capture/renewal time only to verify old scope
and authentication hashes, not to backdate a request. The actual new server
response must explicitly match the account, rotate the key and satisfy the
bounded renewal parser. Its real response receipt controls Max-Age; continuation
also respects the earlier explicit Expires. Maintenance alone grants no retry,
and callers must enforce their authorized one-request marker without retries.

Offline regressions cover seven remaining body requests with no directory/body
1–3 replay, original batch identity, body time, account preview, subsequent live
manual refresh, public/scheduled denial, corrupt cache, consumed interruption,
unrelated stops, locks, stale/expired evidence and config rollback. Separate
normal renewal tests verify omission of expired keys and denial of expired
refresh credentials. All tests use synthetic cookies and temporary files.
Actual network success, saved/openable images, production preservation and
duplicate-safe original refresh must be recorded separately by integration.
