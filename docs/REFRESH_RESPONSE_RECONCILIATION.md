# Validated refresh responses and local receipt reconciliation

An upstream request and its local SQL receipt are separate events. A transport,
body read, JSON/envelope validation or local accepted-receipt write can fail at
different boundaries. Collapsing those errors into one unknown result loses the
evidence needed to diagnose the boundary. An HTTP200 access log without the
response body does not identify the failed boundary or establish acceptance.
An unknown result must not be called a timeout without timeout evidence.

## Minimal receipt bridge

1. Existing SQL admission reserves the source and commits the one-shot attempted
   claim before sending `/add`. It captures the actual Prisma database identity
   and current private instance for the response proof.
2. The provider checks HTTP status, bounded body/UTF-8/JSON, success envelope and
   the exact feed path from the validated subscription list. Numeric and opaque
   feed addresses are supported. A status alone, an empty body, a different feed,
   a cached article or scheduling metadata cannot create an accepted proof.
3. After validation, a small immutable local proof is written to a private temp
   file, fsynced and published without replacement. Readers never see an accepted
   proof before the complete write is synced. The proof retains a response digest,
   not its text, URL, credentials or publisher name.
4. The ordinary strict SQL transaction records accepted. Its verified duplicate
   file can then be removed; cleanup failure cannot downgrade a committed accepted
   receipt. Pending proofs remain when the SQL result cannot be established.
5. The existing worker may repair an attempted/unknown SQL row only from a complete
   matching proof. It rechecks source, reservation, physical database identity and
   proof inside write admission/transaction, then uses a conditional update of
   that same claim. It neither calls `/add` nor allocates another claim.

The proof is bound to the claim/feed, reservation and previous reservation,
source channel/name digest and feed creation time, database device/file identity and private instance
digest. Regular-file/size/checksum/identity/time checks reject truncated, replaced,
oversized, mismatched or future evidence. A preexisting proof prevents a second
attempt even if a caller presents the old ticket again.

No database migration or new scheduling framework is required. Transactions,
physical space admission, durability checks, deduplication, account/instance/stop
gates and independent high-risk backup protection remain. Recovery-copy quotas do
not become ordinary-write gates. No full database copy is created by this bridge.

## Diagnostics and boundaries

Existing batch records gain optional `submissionFailure` and
`reconciliationFailure` fields. Only fixed phases/codes and bounded numeric HTTP
or response-size details are persisted. Transport/headers, body, JSON, envelope,
proof publication and SQL-receipt failures remain distinguishable. Raw exceptions,
upstream messages, response bodies and credential-bearing URLs are excluded.
The original failure remains available after successful reconciliation.

The private `.wechat2rss-refresh-responses` directory accompanies the database's
local task artifacts. Ordinary success removes only the verified duplicate after
the SQL receipt commits. Unresolved proofs must be preserved with any independently
approved recovery operation; this feature does not authorize a backup, pruning,
database restore, file permission change or manual receipt edit. A proof from a
different database identity is not automatically transferred after a restore.

There remains an unavoidable gap if the process disappears after the upstream
effect but before any validated receipt is durable. Missing proof stays unknown.
Historical unknown requests without this evidence cannot be retroactively marked
accepted from HTTP200 logs, check times, unchanged article counts or cache reads.
There is no automatic unknown resubmission or manual-ledger override endpoint.

Receipt recovery verifies request acceptance, not fresh article discovery or
complete bodies/images. Independent cache synchronization can continue while a
batch's request outcome is unknown. A successful cache read with zero changes
does not prove cache-generation time, absence of missing upstream articles or
completion of preexisting body/image gaps. These remain separate observations.

## Offline verification

Tests use owned tiny SQLite databases and mocked transport. They cover invalid
HTTP200 bodies/envelopes, exact list/feed matching, proof fsync/publication faults,
SQL failure before commit and after a committed ACK is lost, a real process exit
after proof publication but before SQL acceptance, process restart,
one-submit recovery, missing/corrupted/mismatched/future proofs, source races,
database/feed replacement, two clients, disk/durability rejection and nonfatal cleanup.
These tests are not evidence that a particular historical production response
was valid or that its cache is fresh. No real platform request is needed.
