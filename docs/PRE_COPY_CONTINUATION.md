# Reference diagnostics and strict pre-copy continuation

This extends the [exact once-pair contract](ONCE_FROZEN_PAIR_ADMISSION.md). It does not grant deployment permission or relax background process bindings.

Reference failures keep the original outer refusal code and additionally emit bounded `REFERENCE_DIAGNOSTIC` JSON at the admission CLI. It contains safe inner code tokens, parser/native stage, coverage/category booleans and allowlisted transport status. Raw facts, PID/path/argv, stdout/stderr, arbitrary messages and stacks are omitted. The probe CLI preserves safe pin/policy error codes before parsing; native completeness failures retain the native code/stage. A later read-only observation cannot reconstruct an earlier unrecorded result. Saved-fact parser replay does not exercise the actual subprocess/CLI or real lock ownership.

## Explicit continuation binding

A failed first admission can leave a valid incomplete ledger before either package slot starts. It remains held by default. The optional `preCopyContinuation` contract has:

- `format:1`, `kind:'verified-pre-copy-continuation-v1'`, a UUID `id`;
- exact `previousPolicy`, `previousLedger`, `previousSentinel`, `previousOutcome` pins, each containing canonical `path`, `sha256` and three-part file `identity`;
- a new confirmed approval ID and `approval.continuation:{id,fromConfigSha,fromLedgerSha,fromSentinelSha}`.

The explicitly supplied expected new policy digest binds the destination without a self-referential policy hash; the durable receipt records both exact from/to digests. The pinned historical outcome records the known failed attempt. Its zero counters are not independent credit proof: the supported old protocol bytes, exact pre-copy state and current target/ownership checks provide that evidence. Supported source bytes are reviewed c438798 pins or the exact current protocol pins, reverified from their immutable files. Historical nonce/token was not archived and is not retrospectively authenticated.

The scope, registry/roots/identities, package pair/proofs, pointer and publication/DB identity/limits stay exact. Recursive policy comparison permits only code/probe/collector pins, the exact disclosed background-process tuple list and specific approval/continuation fields to change. Other fields remain exact. Background changes still require separate explicit risk approval and fresh equality checks; they are never silently refreshed.

## Admission and failure rules

The old ledger permits only the original pre-copy schema: claim=null, outputs=[], exactly two unique slots with started=false, complete=false, identity=null and copied absent/false. Root complete may be absent/false under that old protocol. Unknown state/credit fields, publication state, any started/copied/complete slot, occupied target (including empty directory/link), existing audit root, changed ownership/pins, foreign controls/tmp or concurrent lock refuse. No business data is copied or reset.

Under the existing exclusive lock, continuation creates and fsyncs the fixed `<scope>.state.json.continuation.json` using wx. It preserves the exact old ledger bytes, old adopted content/identities/digests, policy/outcome pins and approval/from/to digests. It then atomically updates the single existing active ledger to the new digest and receipt reference. The original adopted file stays unchanged as the historical anchor. Admission, the final probe and publication share the receipt validator. Only the current held invocation/nonce can use an incomplete continued ledger; later calls require a complete installation.

A failed or uncertain consumption write retains the lock and any partial receipt. Any interrupted or failed continuation remains held. There is no second continuation, alternate receipt name, new scope/approval reset or automatic replay. Completed installation/publication/same-DB rollback still use the original finite credits.

All receipt and temporary bytes count against the existing1MiB metadata ceiling. Receipt/source ownership and exact bytes stay guarded; the receipt is never overwritten or removed. The old failure evidence and current continuation attempt status remain in history, including one known prior execution failure and an explicit incomplete historical-attempt-count claim. Retained logical file size is not total write volume: real control-file writes remain disclosed and budgeted.

New exact tooling/policy/continuation bindings and risks require new explicit approval. Every original process, space, backup, migration, recovery and health gate remains mandatory. This development change never authorizes a production retry by itself.
