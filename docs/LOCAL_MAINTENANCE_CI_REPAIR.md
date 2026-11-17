# Local maintenance contract regression

The recovery candidate must pass both its maintenance-specific checks and the
existing installation, build and observation contracts. A local test pass does
not authorize installation or collection.

The direct-copy installation introduced in `7b1d8c4` omitted the original
three-role budget, exclusive ownership, exact proof validation, reuse and owned
failure cleanup. Restore the previously reviewed implementation rather than
weakening those regression tests. Installation uses `--plan` with the reviewed
private plan; it does not activate a release or remove historical packages.

The build entry must retain its writable-session check, source/runtime-bound
reuse lookup, finite scope and build reservation. A read-only observation cannot
enter it, and an already verified candidate is reused without estimating or
creating another generation. The explicit local Prisma schema-engine override
remains available for offline builds.

The exhaustive host-effect catalog now identifies each new maintenance module.
Native control modules retain their exact code pins and opaque scope/lease
checks. Temporary native fixtures are classified separately and cannot be
imported by production host modules. No source route is added to health checks.

Run the existing finite-lifecycle and host-effect checks, followed by the held
management, exact-binding and installed-adapter checks. CI also runs format,
lint, type, server and existing Windows checks without excluding safety tests.

The Windows native maintenance fixture additionally requires explicitly reviewed
local inputs: `WEWE_FORMAL_NATIVE_SOURCE`, `WEWE_FORMAL_LOCK_SOURCE`,
`WEWE_TEST_PYTHON` and `WEWE_TEST_CONTROL_COMMIT`. The last value is the full Git
commit independently reviewed by the test owner for the four control sources;
the fixture verifies their bytes against those Git objects. New control bytes
require a new freeze. Fixture receipts never grant authority to a real host.

Build the final candidate from the exact CI-verified commit. Retain a local
receipt mapping every source input and packaged control file to that commit and
verify the complete immutable release before handing it to the sole installer.

`release-scope.retireBuildOutput` is a separate, exact reviewed maintenance
operation for an unused `retainedFailure` output, never an installed release or
an active build. It holds the existing registry mutex, checks the original
reference probe and complete native writer census, and freezes the approval,
old policy and ledger before changing that output. A full archive stays inside
the same accounting root and consumes the unchanged byte/growth/free-space
budgets. The archive is fully read back against the source, then actually
restored and checked in the vacated original package slot before final
retirement. No fourth runtime/package copy is created during that rehearsal.

The archive contract covers regular files/directories, content, modes, basic
timestamps and Windows attributes/owner/group/DACL. Only internal directory
junctions targeting a physical directory in the same artifact are supported;
they are not traversed or counted twice. Other links, alternate data streams,
EFS, sparse and compressed NTFS objects are refused. Junction metadata is read
through a non-following handle; named ACL writes never pass through a junction.
Windows ACLs are
restored before timestamps and compared as full SDDL, including inheritance
flags; see Microsoft's [SetNamedSecurityInfoW documentation](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setnamedsecurityinfow).
Unknown or changed restore destinations are never overwritten. A failure
before commit restores the original logical data/metadata and keeps a durable
intent; an incomplete or unverified recovery blocks ordinary builds. A killed
mutex owner remains fail-closed and requires the existing owner review; the
entry never clears an unexplained lock. Replays verify the immutable archive
and return the prior result without a second retirement.

Only the reviewed source commit/hash and the precisely verified archive's
frozen baseline advance. All other policy fields, roots, protected packages,
references, capacity limits and scan limits remain unchanged. The archived
original ledger/policy and retained failure diagnostics remain available for
recovery. A maintenance-tool commit and the exact candidate commit may differ;
this grants no exception to the candidate's exact-commit CI requirement.

An exact, unstarted preparation from the initial implementation omitted the
standard empty `claim.outputs` list and was correctly rejected by the original
reference observer. `abortBuildRetirementPreparation` accepts only that pinned
pre-archive defect, with unchanged complete outputs, no archive/progress/result,
and its original immutable review/ledger snapshot. Under the same mutex it
restores the actual prior state, runs the unchanged full reference and native
checks, and records an audit. A refusal reinstates the held intent. It cannot
abort another claim, a started archive, or changed/unknown output history.

`release-scope.recoverFailedBuild` handles one explicitly reviewed interrupted
build with a retained nonempty output. Its pinned review binds the original
ledger, adoption marker, output inventory, owner, failure log and next policy.
The existing registry mutex, native process census and original reference probe
must all pass before an atomic registry update. The failed output remains at its
original path, is frozen and charged to the same capacity, and cannot be
published. Original ledger/policy/log bytes are retained in a recovery snapshot.
The next policy may update exact source bindings and finite existing inventory
profile limits; byte capacity, roots, protected controls and physical reserve
remain fixed. Its runtime allowance includes the retained failed copy explicitly.
Repeated recovery is read-only; an interrupted precommit leaves the original
claim intact. This local build recovery grants no production installation or
source-collection authority. Budget refusals retain their original error cause.
Successive failures retain and revalidate the earlier snapshots and inventories.
For a legacy record without a PID, recovery additionally requires pinned evidence
of an observed failed process exit and a complete native census of the entry and
related writers; it never substitutes an invented PID. During a build, external
inspection processes must not reference its exclusive output root.
