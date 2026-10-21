# Isolated build and search rollback

These commands prepare reviewable packages. They do not authorize installation,
database migration, active-pointer publication or a production restart.

Use a clean, writable checkout with the lockfile dependencies already installed,
the pinned Windows Node 24.11.1 runtime, an empty isolated output directory, and a
registry outside all output/accounting roots. Keep production data and credentials
out of this checkout. Do not copy a production database to prepare a build.

## Build-only policy

Run `node scripts/local-release/build.cjs --compact --build-only --output-root <absolute-output> --plan`.
The read-only plan reports the committed source SHA, input digest, pinned compiler
entry files, runtime hash and conservative copy reservation. Review these exact
values in a release-scope policy with `phase: "build-only"` and the reported
`buildOnly` object. Retain the normal roots/identity inventory, byte/runtime/free
space limits, scan limits, protected historical package IDs, manifests, rollback
plan, registry owner, native reference collector and pinned probe. The isolated
output root must be a separate registered root, empty on first adoption. Existing
history is still counted and hashed; it is not replaced by an empty inventory.

Set the normal `WEWE_RELEASE_SCOPE_FILE` and `WEWE_RELEASE_SCOPE_SHA256` to the
reviewed policy, then repeat the command without `--plan`. Native process,
scheduled-task, shortcut, pointer, rollback and inflight coverage must remain
complete. A denied/incomplete query stops the build; do not substitute synthetic
facts for native observations. Build-only omits the _future pair compatibility
proof_, and explicitly returns `verified: false` for that stage. It is never a
candidate-installation acceptance.

The build runs inside the existing lease and build-budget locks. It creates only
registered owned outputs, pins compiler entry hashes, rejects runtime/DB entry
points, private build environment files and pointer access, and clears service
configuration from compiler environments. Vite's temporary config, environment
directory, cache and output live in the owned build directory. Source and
dependency reads are still needed. The fixed build source and installed toolchain
are trusted code; this is an operational boundary, not an OS sandbox for malicious
dependencies (esbuild manages its own subprocess). Interruptions retain the
existing held-claim/review behavior. No historical package is deleted to gain room.

## Narrow search-compatible rollback recipe

Prepare an isolated source snapshot of
`48fdf73f4d770001bbb6de3e2383189811e56ccb` with its lockfile dependencies available.
Do not patch that snapshot or edit any frozen package. Use the current reviewed
builder with `--source-root <snapshot> --source-commit 48fdf73f4d770001bbb6de3e2383189811e56ccb --search-rollback --compact`, plus the build-only flags above.
Create and review a separate exact plan/policy for this source/input pair.

The recipe compiles the original application and Prisma client, adds the exact
global-sort migration20 and search migration21 only to the **new package**, and
records source SHA, tooling SHA, input/file hashes and
`rollbackCompatibility: "search-additive-21-v1"`. It preserves the candidate's
PR82 search and exportIds code; the rollback application itself retains the older
feature set.

The new rollback gate requires schema20 and accepts schema21 as its only optional
extension. Node and Python inspectors pin the entire 20-migration inventory and
the LF-normalized search SQL hash
`ff72e5e104374f9ce6b45ef8a9b0320a8bc310a26a447a33f2e4636cf2c36fad`
(reviewed CRLF bytes:
`7c1eb279edcce24879c4721490046364769abd053f7c6a3d922d42cb0fa9ec3b`).
They check migration completion/duplicates/checksums and the complete reconstructed
SQLite object definitions, including triggers and partial indexes, allowing only
CRLF/LF normalization. Unknown tables, views, migrations and SQL drift fail closed.
Neither inspector migrates or downgrades the database.

## Acceptance still required

Gate tests are not runnable-package or application-recovery evidence. Before any
installation, build and fully verify both real packages, seed a small synthetic
schema20 database with all nine business tables and an unknown submission claim,
record its row digests, apply the exact migration21 and receipt, and start the
actual candidate and rollback through their HTTP/runtime paths. Check the business
rows and unknown claim after each application's startup recovery. Exercise an
injected candidate-start failure and prove rollback actually starts. Record
`businessDatabaseRestored: false`, package/source/manifest bindings, process
identities, bounded logs and the four independent preservation/rollback checks.

Only after this evidence is independently reviewed may a **new formal policy**
with the exact candidate/rollback pair proof authorize installation or switching.
A build-only policy cannot authorize those operations. Keep the full proof and
machine audit private; commit only non-sensitive code, tests and documentation.

As of this change, local gate tests have passed, but this restricted executor has
not produced or started the real package pair. Its native CIM/task visibility was
previously denied and junction creation also fails with EPERM in an explicitly
writable test directory. These are unresolved environment blockers, not passing
rehearsal results. Do not weaken assertions or fabricate complete native facts.
