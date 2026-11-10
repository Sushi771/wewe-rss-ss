# Prior-boot empty-install recovery

This candidate extends only the existing empty-install recovery and controlled
restart paths. It is not a general stale-lock remover. It does not infer a
successful source request or clear collection safety state.

An output-free interrupted claim may retain an exact process family from before
a system reboot. The reviewed proof must include a complete old reference
preimage that reproduces the original claim digest, with explicit captured or
reconstructed provenance. Reconstructed evidence is not a historical native
observation. The current native query must prove that the project process set is
empty and every other digest-participating reference is unchanged, except for
the separately pinned controller update. Console processes already incorporated
into reference records remain part of the digest and family proof.

The shared helper has three roles:

- `readPriorBootEvidence(policy)` reads pinned original writer, database, active
  release and evidence files, and obtains two observations from the fixed native
  observer. It does not itself declare eligibility or acquire locks.
- `validatePriorBootLeaseEligibility(...)` checks the old exact preimage, complete
  family, original writer and two fresh prior-boot observations. A private
  integration caller may use this qualification without claiming a complete
  current reference query.
- `validatePriorBootEmpty(...)` uses the same qualification plus the complete
  current reference result. Only the exact old family becoming empty is admitted.

Proof fields and source hashes are exact, including the helper, observer,
original recovery module, normal lock module and changed restart launcher entry.
Unknown proof fields and unrelated policy changes are rejected. The reference
probe keeps its existing scope-lock and inflight validation.

Controlled restart keeps its ordinary live-process branch unchanged. The
prior-boot branch checks qualification, capacity and a protected backup before
archiving the original writer through the existing recovery function under both
normal locks. Backup or admission failure cannot start the old application.
After real archival, the existing candidate start, complete family admission and
same-schema fallback are reused. The new writer is verified before releasing
locks and publishing the active pointer. Uncertain lock-release failures are not
retried and do not grant fallback permission.

Reports retain `oldStopped: false`, use the explicit prior-boot reason and pin
the actual lease/intent/completion records. No native Stop receipt is synthesized.
Original claim and writer history remain available. No business database restore,
extra backup allowance, authentication reset or source retry is introduced.

## Validation

Run the helper, scope, reference-probe, prior-boot restart and ordinary restart
tests. Synthetic tests distinguish proof validation from orchestration: the
restart harness simulates native processes while using isolated files; the scope
lifecycle exercises the real scope with simulated native qualification. They do
not demonstrate a real installation or restored collection. Native evidence,
full CI, independent review and the authorized installation checks remain
required before release.
