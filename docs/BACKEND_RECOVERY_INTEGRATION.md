# Production-based recovery integration

Integrate on production baseline `535a68f`, retaining its existing UI and write
coordination. The candidate combines bounded SQLite backup preparation and
unchanged-source verified snapshot reuse, consistent article-list reads and
metadata-page reuse, responsive classification assignment/sorting, and durable
automatic preparation retries. It requires one worker version for its state
directory and one backend/frontend release built from the same candidate.

## Existing connections

The service already attaches the batch refresh callback and read-only receipt
reconciliation. Its initialization waits for successful startup backup audit
before initializing saved tasks. The automatic scheduler uses the existing
Shanghai slot intent and watermark. No new public mutation or external connector
is required. Read-only status endpoints do not recover or submit queued work.

## Runtime scope

- Server: `collection/sqlite-backup.ts`, new `collection/sqlite-backup-reuse.ts`,
  `scripts/backup-sqlite.py`, `article-list-page.ts`, new `article-list-cache.ts`,
  `trpc/trpc.router.ts`, and `collection/wechat2rss-subscription-batches.ts`.
- Web: new `components/FolderMemberPicker.tsx`, `components/ManagementFolders.tsx`,
  and `pages/feeds/index.tsx`.
- Database schema, dependencies, provider configuration, export paths, saved
  article bodies/notes and the existing Prisma admission coordinator are unchanged.

## Validation and activation boundary

Verify the combined backend, web types/build, actual React callbacks and isolated
native browser behavior. Keep private Windows cache-lifecycle and existing-large-
copy acceptance records local. Reuse bypasses WAL/active journals and does not
authorize external maintenance writers; actual writer coordination remains an
application-process contract.

The final retry-claim guard rechecks deadlines after asynchronous reads and after
the durable claim. Before activation, review legacy intent overlap: a later
accepted recovery can overlap older unsent records, so classify the
activation scope from durable receipts rather than an assumed failed-item count.
The existing atomic per-feed submission reservation remains in force.

Older workers cap preparation counts at three and skip records with higher counts.
Prepare a compatible rollback program before activation; never replace newer
receipt-bearing state with an older snapshot merely to make the old parser accept
it. This integration does not authorize deployment, service restart, platform
submission or manual scheduled-round replay.
