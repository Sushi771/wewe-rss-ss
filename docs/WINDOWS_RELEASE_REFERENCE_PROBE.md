# Read-only Windows release reference probe

`scripts/local-release/windows-release-references.cjs` implements the existing
`release-scope.cjs` probe protocol. It does not change the accounting verifier,
install, stop/start a service, remove a package, restore a database, recover a
claim, or approve a historical capacity exception. The application and its
already frozen packages stay unchanged.

The production owner must independently review this adapter and a concrete
private policy before invocation. This change has only synthetic acceptance;
there is no claim that production discovery or a live switch has passed.

## Sources and refusal behavior

The CLI accepts exactly one policy file. It has no cached-evidence, fixture,
partial-success or injected-JSON command-line mode. It verifies its own pinned
source and the adjacent collector script both before and after collection.
It launches the existing system Windows PowerShell with `-NoProfile` and
`-NonInteractive`; execution-policy or privilege failure remains a refusal.
It does not change an execution policy or system settings.

The collector reads two `Win32_Process` snapshots, two `Get-ScheduledTask`
action snapshots, `Win32_UserProfile`, and the current/common Desktop,
Start Menu and Startup known folders. Existing `.lnk` files are resolved with
`WScript.Shell.CreateShortcut` without calling `Save` or launching the link.
Shortcut bytes are hashed and checked independently by Node. Every known-folder
coverage record carries its canonical path and native volume/file-index/creation
identity. An absent folder carries the nearest existing ancestor's canonical
identity instead; the missing path is checked again at publication. Enumerated
directory identities and entry lists are rechecked to detect replacement and
additions/removals, and each folder/shortcut must bind a complete inventory.
The adjacent pinned C# helper uses read-only handles without following a directory
reparse point; parent path aliases, inaccessible and remote paths refuse. Windows
PowerShell loads this helper with `Add-Type` (its compiler may use OS temporary
files); it does not create a production identity cache or change system settings. Disabled
tasks still count. Unrelated browser shortcuts do not become package references.

The Node resolver canonicalizes direct executable/argument paths, including
junction aliases, and resolves them to an ancestor `release.json` within the
registered accounting roots. The manifest ID and full manifest SHA must match
the policy. It traces a reviewed stable launcher invocation through the active
pointer only when its exact argv, executable SHA, working directory and pinned
launcher source files match. This is an explicit reviewed mapping, not inferred
code analysis. The policy author must include the complete relevant launcher
dependency closure; pinning only an entry script is not evidence that its
imports cannot change. A launcher process with no observable cwd additionally
requires the reviewed `cwdIndependent: true` assertion; use it only for a
launcher whose path resolution is entirely absolute or based on `__dirname`.
Unreviewed PowerShell `-File`, WScript/CScript, batch, encoded/eval/shell flags,
outside script entries (including renamed hosts), relative unresolved package paths, unknown launchers,
changed launcher files and fourth protected packages hold admission.

Unrelated task/shortcut native applications also need an explicit bounded
`harmlessActions` entry with kind (`tasks` or `shortcuts`), exact argv, working
directory and executable pin. This does not allow a script host to bypass the
reviewed launcher mapping. There are no wildcard actions or implicit browser
exceptions. All configured executable contents and identities join the final
watched-file audit, with the existing 256-MiB executable read bound retained.
Other immutable policy/probe/collector/helper/proof files are likewise rechecked
after resolution. These checks are repeated observations, not an atomic OS-wide
snapshot or a static proof of arbitrary executable behavior.

Relevant processes and their recursive children require PID, parent PID,
creation time, command line and a freshly hashed executable. PID reuse,
termination, changed snapshots or newly appearing relevant descendants hold
admission. Unknown executable/command-line visibility is not classified as
irrelevant. The fixed kernel entries PID 0/4 are accepted only with the native
System/System Idle Process names and no executable or command line.

Only this exact probe invocation and its one exact collector child are excluded
from controller descendant records. Their parentage, argv, executable paths
and stable two-snapshot identities must match; any additional child holds the
query. This avoids a new probe PID changing the reference digest on every
checkpoint while retaining unrelated controller/runtime children.

The adapter also reads every registered root's direct `active.json`,
`.build-budget.lock`, `.release-lifecycle.json`, and the scope registry lock and
checksummed ledger. The controller PID must be the actual probe parent, present
with a stable creation time in both snapshots, with the matching policy hash
and nonce lock. Its own validated changing intent is not an external reference
to its own output. Foreign build owners, corrupt/foreign claim envelopes,
outside paths and unreviewed rollback roles hold admission. This depends on
the scope controller's exclusive-lock protocol; it is not a stale-lock recovery
tool. Referenced external rollback plans remain stable external records.

All configured immutable file sources are rechecked before returning. A failed
query returns `complete:false`, incomplete category flags and a bounded error
code; raw process command lines and private evidence contents are not printed.
The native collector is bounded to 16 seconds, 8,192 processes/tasks/shortcuts
and 4,096 shortcut directories. The child process has a 20-second/4-MiB output
bound, inside the scope caller's 30-second probe bound. Exceeding a limit holds
admission; no limit is increased automatically.

This minimal collector covers the current user and common known folders.
Another non-special local user profile, inaccessible task, unresolvable COM
task action, shortcut directory reparse point, or unreadable process is an
explicit coverage failure. It does not pretend that an unprivileged query can
prove absence of hidden processes or other users' references. No UAC elevation,
impersonation, registry edits or fallback to old evidence is attempted.

The accounting roots and reviewed rollback documents define the filesystem
reference scope. Additional nonstandard launchers, custom rollback files,
other user profiles, or nested writer control directories require an explicit
adapter/policy review before use. A generic `complete:true` fixture is not an
authoritative host inventory. The storage verifier still independently accounts
all files; this adapter does not exempt old packages or classify them as safe
to delete. Existing pre-migration recovery references must be represented in
the exact reviewed rollback document; a fourth package then stops admission.

## Private policy extension

Keep every concrete policy, path inventory, host process snapshot and acceptance
proof outside Git. The existing scope policy still pins `probe.path` and
`probe.sha256`. Add `windowsReferences` (all hashes are lowercase SHA-256):

```json
{
  "format": 1,
  "collectorSha256": "<hash of adjacent collector.ps1>",
  "collectorIdentitySha256": "<hash of adjacent windows-reference-directory-identity.cs>",
  "packages": [
    { "id": "<current-id>", "path": "<absolute existing package path>" },
    { "id": "<candidate-id>", "path": "<absolute frozen source path>" },
    { "id": "<rollback-id>", "path": "<absolute frozen source path>" }
  ],
  "launchers": [
    {
      "entry": "<absolute reviewed logon-start.cjs>",
      "argv": ["<absolute node.exe>", "<same entry>", "start"],
      "workingDirectory": "<absolute project directory>",
      "cwdIndependent": true,
      "executable": { "path": "<absolute node.exe>", "sha256": "<hash>" },
      "files": [
        { "path": "<entry>", "sha256": "<hash>" },
        { "path": "<each reviewed dependency>", "sha256": "<hash>" }
      ],
      "pointerPath": "<registered root>/active.json"
    }
  ],
  "rollbackFiles": [
    {
      "path": "<absolute reviewed rollback-reference document>",
      "sha256": "<hash>"
    }
  ],
  "harmlessActions": [
    {
      "kind": "shortcuts",
      "argv": ["<absolute reviewed browser.exe>", "http://127.0.0.1:18080/#/"],
      "workingDirectory": "<absolute reviewed directory>",
      "executable": { "path": "<same browser.exe>", "sha256": "<hash>" }
    }
  ],
  "compatibilityProof": {
    "path": "<absolute reviewed acceptance proof>",
    "sha256": "<hash>"
  }
}
```

`packages` contains up to six existing physical copies, covering every one of
the at-most-three policy `protectedIds`. Source and installed duplicates must
not be mistaken for separate IDs or for physically freed capacity.
`policy.packageProofs[id]` remains the full manifest SHA for every copy.
No package source or private policy is generated automatically by this adapter.

A rollback-reference document has the exact shape
`{"format":1,"packages":[{"id":"<id>","path":"<absolute existing package>"}]}`.
Include every actual held recovery reference, not only the desired future role.
A missing, altered, unapproved or unresolvable entry refuses the query.

The independently reviewed compatibility proof must be pinned by both
`windowsReferences.compatibilityProof.sha256` and the existing
`policy.compatibilityProofSha256`. It is an acceptance summary bound to the
actual frozen manifests and source commits, not a generic schema label:

```json
{
  "format": 1,
  "kind": "additive-schema-unknown-claim-rollback",
  "businessDatabaseRestored": false,
  "candidate": {
    "id": "<candidate>",
    "sourceCommit": "<40 hex>",
    "manifestSha256": "<64 hex>"
  },
  "rollback": {
    "id": "<rollback>",
    "sourceCommit": "<40 hex>",
    "manifestSha256": "<64 hex>"
  },
  "checks": {
    "additiveSchema": true,
    "unknownClaimsPreserved": true,
    "businessRowsPreserved": true,
    "rollbackStarted": true
  }
}
```

The adapter verifies binding and the reviewed assertions; it does not rerun
these acceptance experiments or manufacture their truth. Retain and review the
underlying rehearsal evidence before pinning the summary. A proof claiming
database restoration, absent checks, or different manifest/commit is rejected.

## Offline verification and integration

Run `node --test scripts/local-release/windows-release-references.test.cjs`.
Fixtures contain only tiny inert executables, manifests, text pretending to be
shortcut bytes, synthetic host API results and an owned temporary junction.
The suite exercises the real scope guard with those facts and changing own
claims. It never calls native production discovery or executes a fixture file.
Regression tests include the independent R1-R3 counterexamples, before/late
missing-directory appearance, ancestor/directory replacement with unchanged
names/bytes, and late executable content/identity replacement. A Windows-only
test loads just the directory helper against an owned temporary fixture and
compares its identity with Node; it does not collect host references.
The PowerShell collector is syntax-checked separately; its privileged Windows
API behavior still needs independent host acceptance before production adoption.

The main integration owner should add this test command to its Windows and
portable gates. No shared CI file, accounting scan code or production workspace
is changed by this isolated patch. A localized reference-contract change in
`release-scope.cjs` accepts `viaPointer` task/shortcut records only when paired
with a matching, canonical pointer record in the registered roots. During an
explicitly allowed pointer transition, stable comparison keeps the task/link
identity, pointer path and pinned launcher digest unchanged while permitting
its resolved protected package target to follow that pointer. Direct tasks,
direct shortcuts, rollback records and all other fields remain fixed. The
actual-scope synthetic test exercises this transition; suppressing the resolved
target without this contract would either misstate the reference or block every
real stable-launcher switch. This change is separate from the main owner's
large-inventory verifier work.

The probe must be invoked through the scope
controller so that an authoritative, matching controller lock/ledger exists;
running it standalone is expected to refuse. No production policy is enabled
or installed by this delivery.
