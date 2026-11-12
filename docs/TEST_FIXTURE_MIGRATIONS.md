# SQLite test fixture migration connections

SQLite migrations that contain native BEGIN/COMMIT statements must execute all statements of that migration on one connection. Awaiting statements in sequence on an ordinary Prisma pool does not provide that guarantee.

The test-only withFixtureMigrationConnection helper takes an explicit synthetic fixture URL and the caller's existing migration body. It creates a separate Prisma client with connection_limit=1 and disconnects it in finally. It retains the original path and other URL parameters, accepts an existing unambiguous connection_limit=1, and rejects conflicting or duplicate limits. It does not discover URLs from environment variables or client internals, retry statements, wrap native transactions in Prisma transactions, select migrations, or change production clients.

Callers retain their ordinary business clients and their existing connection settings. Migration order, filters, historical through/after phases, deferred table creation, SQL, seed data and business assertions remain in the caller. The insert-only-cache restoration call continues using its original business receiver. Existing safe single-connection and DatabaseSync fixtures are unchanged.

The audit covered all 258 Server specs, 14 research specs, the e2e spec and all 35 SQLite migrations at the reviewed base. It found 48 direct initialization gaps and six shared-helper callers with the same missing affinity guarantee. One additional shared-helper caller was already single-connection and only needed the explicit URL interface adaptation. Not every source-level gap had failed in CI. Observed setup failures included missing transaction-local rebuild tables and locked databases; the logs do not identify the connection used by each statement.

Regression coverage includes exact URL preservation, invalid/ambiguous URL rejection before connection, callback error propagation, disconnect behavior, and a real isolated SQLite BEGIN/rebuild/COMMIT read from an unchanged ordinary business client. Existing full Server and cross-platform CI suites remain required. This test-only change does not establish production collection recovery or authorize installation.

The xhs-auth-session-review spec prepares its temporary SQLite directory, ordinary business client, and complete migration set in beforeAll; afterAll cleans up even after partial setup failure.
Seed writes, all eight real business transactions, and all assertions remain in the test body.
Setup, the test, and cleanup each retain Jest's default five-second timeout, rather than sharing the former single aggregate five-second budget.
This separates fixture lifecycle from business verification; it does not establish which phase caused a CI timeout or demonstrate that CI is fixed.

The xhs-source-risk-store spec creates and migrates a separate temporary database for every case. Its teardown now disconnects and removes that database without the redundant common row-level UPDATE/SELECT/DELETE hook. The raw-author identity case retains runtime shutdown but omits four redundant row-cleanup calls. Business bodies, assertions, synthetic inputs, request counts and existing timeouts remain unchanged.

Teardown captures the current client and directory before awaiting disconnect. This prevents a delayed teardown from reading a directory slot replaced by a later case. Removal occurs only after successful disconnect; a rejected disconnect leaves the directory intact. This does not cancel a timed-out test or prove that all asynchronous work has stopped.

Offline targeted validation passed both raw-identity variants (2 cases). A private controlled-Promise check verified disconnect-before-removal, no removal after rejection, original-directory ownership after slot replacement, unchanged per-case setup and exact cleanup-only source differences. The observed Windows CI timeouts and EBUSY reports have not been reproduced or assigned a proven root cause. Full cross-platform CI remains required; these results do not establish production recovery or authorize installation.
Adjacent offline coverage also passed the scheduled raw-identity mismatch, remaining-detail continuation after local pre-dispatch failure, and older-started-detail blocking cases (3 cases).
The exact durable response-settlement failure case also passed in isolation (1 case). Six targeted cases passed in total; this remains offline evidence, not a demonstrated CI root-cause fix.

The existing Windows CI failures on a2dde remain unresolved. Six passing local cases do not replace full cross-platform CI for this candidate.

## Timed-out setup ownership

The `xhs-p0-source-risk-full` spec now binds each setup and cleanup to its own client and directory. A timed-out Jest hook is not cancelled automatically. A controlled short-timeout reproduction showed that the previous setup could continue through the next case's mutable client slot and produce a nested SQLite transaction. This establishes the cross-case failure mechanism, not the cause of the original 40-second setup delay.

The fixture marks itself closed before waiting for its own setup and cleanup to settle, then disconnects once. It checks closure before each migration statement and never publishes a late client into the suite. Successfully closed fixtures leave the pending set; all directories remain available for inspection. Network guards remain installed until pending fixtures settle, and final close failures are reported after restoring the guards. Existing migration SQL, cleanup SQL, business tests, assertions and timeouts are unchanged. No migration cache, retry or production-client change is introduced.

Two controlled-Promise regressions cover a pending file read and an already-started SQL statement while a later fixture uses an independent client. The final isolated spec passed 76 tests, with TypeScript, ESLint and formatting checks. Full cross-platform CI remains required; these local results do not establish that the original setup-delay cause is resolved or that production collection has recovered.
