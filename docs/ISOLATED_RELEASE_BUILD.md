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
`buildOnly` object. This phase registers exactly one new output root, empty on
first adoption, and its separate registry/control directory. Retain their exact
identities, source/tool/compiler pins, byte/runtime/free-space limits, bounded
output inventory and exclusive locks. Production and historical roots must not
be registered in this phase. Their contents and global native references remain
unknown; this is no history inspection, deletion or installation authorization.

Set the normal `WEWE_RELEASE_SCOPE_FILE` and `WEWE_RELEASE_SCOPE_SHA256` to the
reviewed policy, then repeat the command without `--plan`. Build-only observes
only its new output and control directories and does not query global processes,
tasks, shortcuts or production pointers. It explicitly keeps global references
unknown and pair compatibility unverified. Other release phases keep their
existing reference requirements. This is never installation acceptance.

The build runs inside the existing lease and build-budget locks. It creates only
registered owned outputs, pins compiler entry hashes, rejects runtime/DB entry
points, private build environment files and pointer access, and clears service
configuration from compiler environments. Vite's temporary config, environment
directory, cache and output live in the owned build directory.
Git-tracked environment fixtures must match their exact committed blobs and are
recorded only as input hashes; they are never passed to compilers. Fixed package
boundaries in the owned release and build directories stop Prisma from finding
an ancestor environment file. Untracked or changed environment files are refused.
Source and dependency reads are still needed. The fixed build source and installed toolchain
are trusted code; this is an operational boundary, not an OS sandbox for malicious
dependencies (esbuild manages its own subprocess). Source snapshots and input
hashes are checked before and after compiler calls. Failed outputs and interrupted
claims are retained for review; build-only cannot authorize their deletion.

## Narrow search-compatible rollback recipe

Prepare an isolated source snapshot of the installed UI repair
`f618e48f48ff0e3df1c646cb8a666a2461815732` with its lockfile dependencies available
(the earlier `48fdf73f4d770001bbb6de3e2383189811e56ccb` remains accepted).
Do not patch that snapshot or edit any frozen package. Use the current reviewed
builder with `--source-root <snapshot> --source-commit f618e48f48ff0e3df1c646cb8a666a2461815732 --search-rollback --compact`, plus the build-only flags above.
Create and review a separate exact plan/policy for this source/input pair.

For this rollout the candidate source snapshot is exactly
`3a36428210f22ea1986f0a96a6066e7fdc9baf46`. One unchanged build-only policy may
bind both exact `{sourceCommit, sourceHash}` plans in `buildOnly.sources`; only
this candidate/repaired-UI rollback pair is accepted there. Both builds share
one output inventory, lock and ledger. No third source or receipt refresh is
authorized. Keep the original 768 MiB cumulative new-output budget and two
runtime copies. Build sequentially: the copy peak is the retained completed
first package **plus** the second build reservation, not one reservation reused
as a two-package total. With reservations of 593,710,908 bytes each, the first
package must be at most 211,595,460 bytes before the second can begin; actual
bytes and free space are checked then. Subtract the policy's own control-file
reservation from that bound as well (64 KiB gives 211,529,924 bytes). Otherwise stop and preserve it, without
deleting packages or raising the budget. Reserve at least 4 GiB free disk after
each allocation. Compiler workspace and temporary files stay in the reservation.

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
