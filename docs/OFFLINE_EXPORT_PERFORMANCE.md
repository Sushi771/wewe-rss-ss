# Bounded offline feed export

The previous feed ZIP staging query selected up to 5001 complete cached bodies
before checking the 5000-article limit. Large inline images therefore remained
reachable for the entire export, even while only one article was being converted.

Feed export now freezes the filtered IDs in publish-time descending, ID ascending
order. It checks the existing limit before loading HTML, then reads at most eight
articles at a time. Each article's body, title, date, source and media status are
selected together. Body conversion and filesystem publication occur after that
database statement returns; no transaction is held over filesystem work. New
articles cannot enter an ongoing request. Deletion of a selected member aborts
the request rather than silently producing a smaller archive. Concurrent edits
are read at the time of the corresponding batch; this is a membership snapshot,
not a database-wide historical snapshot.

This bounds the number of retained database bodies, not their individual byte
size. Eight unusually large bodies can still require substantial memory. The
existing per-article image limits remain in force. The extra short queries trade
some small-feed latency for reduced body retention on large exports.

The controller continues to produce the complete ZIP in its own temporary tree
before sending response headers. Conversion errors, incomplete media reporting,
atomic article publication and final temporary cleanup retain their existing
semantics. ZIP compression is unchanged. No pre-existing Vault is scanned by this
browser ZIP path; its staging root is new. Existing incremental local saving is
unchanged, including verified receipts, duplicate detection across old layouts
and group assignments, symlink checks, repair and user-edit protection. A directory
index was deliberately not substituted for those checks in this patch.

## Reproducible evidence

From `apps/server`:

```
node --expose-gc -r ts-node/register/transpile-only -r tsconfig-paths/register scripts/benchmark-offline-export.ts
```

The benchmark creates a new synthetic SQLite database and export tree for each
child process and accepts no database or output-root argument. It alternates the
exact `33ec7c3` implementation and the current implementation, five samples each.
The fixture has 32 cached articles, roughly 137 KiB text per body and one inline
PNG each. It uses one SQLite connection, actual Markdown conversion, image files,
receipts and local publication; any network request fails. It compares Markdown
and image hashes, stage output bytes, body-query counts, wall time and sampled
process RSS/heap. Startup/import/fixture creation are outside wall timing. Peak
memory is sampled every 5 ms and can miss short synchronous peaks. Output size is
the completed staging tree, not a measured peak of ZIP-plus-stage disk use. ZIP
compression, browser transfer and production load are outside this microbenchmark.
Record machine/runtime, competing I/O and P50/P95 with results; do not interpret
small synthetic data as an absolute latency guarantee.

Focused regressions:

```
node node_modules/jest/bin/jest.js --runInBand offline-export-bounded article-export-main-boundary article-export-source-link article-incremental-export article-local-save
```

## Design reference

[Archiver](https://github.com/archiverjs/node-archiver) and its
[API reference](https://www.archiverjs.com/docs/archiver/) document streaming
archive pipelines, completion and errors. Streaming directly to HTTP would change
the current ability to return an ordinary error before publishing response bytes.
This patch keeps staged completion and improves the preceding database-body
retention without changing that delivery contract or adding dependencies.

## Initial paired measurement

On Windows with Node 24.11.1, five alternating samples per variant gave stage
wall P50/P95 7369.90/7790.89 ms before and 7335.35/8049.71 ms after. This shows
no material speed gain; P95 was slightly higher. Sampled RSS P50/P95 changed from
440.62/443.97 MB to 430.05/431.97 MB; heap P50 from 270.07 to 258.50 MB (decimal
MB). Maximum body rows returned per query changed 32 to 8; query count 1 to 5.
Completed stage size was 4,517,829 bytes in both variants, with identical Markdown
and PNG hashes. The host also ran isolated browser and regression workloads,
so these are comparable alternating samples in a shared environment, not an
exclusive-host benchmark. The small fixture establishes reduced body retention,
not a universal export latency target. Full HTTP ZIP completion was not timed.

## Incremental local saving

Standalone sourced saving still makes a fresh directory/receipt discovery under the
existing cross-process article identity lock. A preparation without an early
identity keeps the previous discovery path. For a preparation with an early
identity, the publisher now reuses the discovery made during that same locked
save rather than scanning every group/publisher a second time. Repair candidates
are read again before publication, and the existing receipt-byte, file/hash,
image, Markdown, conflict and atomic publication checks remain active. Nothing
is remembered from an earlier save's filesystem validation.

The lock identity is captured as frozen article/source/feed primitives before the
first await. Discovery and the lock key use this snapshot. Both staging and
publication reject a prepared result with another identity; changing the mutable
preparation identity during staging cannot grant permission to reuse discovery
under the wrong article lock.

Media analysis is lazy and uses a process cache keyed by version, exact body SHA256
and body status. Values contain only image-source MD5 prefixes and the content's
legacy-inline/uncertainty flags. The cache retains no body, DOM, source URL,
filesystem success result or user file. It is limited to 512 entries and 512 KiB
of logical string/entry weight; an input above 8 MB or an analysis exceeding the
budget is checked but not cached. These logical limits do not promise an exact
V8 heap allocation. Entries may be evicted; a loop larger than the budget can
have little reuse. A cold legacy receipt still requires analysis, while a warm
exact-content hit avoids repeated DOM construction. Content/status changes miss.
Existing exports and receipt formats are unchanged. New exports reach the actual
converter without first constructing the retained-media DOM.

The cache never replaces the current per-save receipt, Markdown and image checks.
Changes to a cached body, newly appearing image sources, pending flags, invalid
inline bytes and missing image files retain their previous incomplete/repair
semantics. Hashing does not make a modified note eligible for overwrite.

The benchmark below operates at the local-store layer and deliberately has no
database reads. Its input bodies are already supplied, as in a prepared internal
job; zero body queries here is not a claim about a browser API's database reads.

```
node --expose-gc -r ts-node/register/transpile-only -r tsconfig-paths/register scripts/benchmark-incremental-export.ts
# Set EXPORT_BENCHMARK_SCALE=200 for 196 additional managed empty publishers,
# keeping 12 target bodies; that independent scale uses three pairs.
```

The four-publisher fixture has 12 bodies of about 32 KiB and one valid inline PNG
each. It compares five alternating independent-process pairs with the exact
`33ec7c3` implementation. The all-skipped case is explicitly warmed once before
timing, including the cold legacy media-analysis path. The few-new case contains
12 already saved items and two new items. Real files, managed source receipts and
image hashes are checked. No upstream request is allowed.

| Directory-stage scenario      | Old P50/P95 ms    | New P50/P95 ms    | Root discovery scans old/new |
| ----------------------------- | ----------------- | ----------------- | ---------------------------- |
| First 12 articles             | 2574.62 / 2819.95 | 1746.97 / 1820.28 | 24 / 12                      |
| All 12 skipped, warm analysis | 991.87 / 1129.08  | 928.83 / 964.90   | 12 / 12                      |
| 12 skipped, 2 new             | 1514.31 / 1568.69 | 1307.71 / 1364.32 | 16 / 14                      |

Markdown/PNG hashes match throughout. Output sizes are 402,468 bytes for the first
two cases and 469,524 bytes for the third in both versions. First-export sampled
RSS P50 changed 166.11 to 158.52 MB; warm-skip 170.83 to 166.81 MB; few-new 173.81
to 167.33 MB. Samples ran on a shared Windows host with other isolated tests, so
the figures describe this fixture rather than an absolute performance promise.

Phase one deliberately deferred a request-wide directory index. Freezing directory
candidates before acquiring a target's identity lock can miss another process's
newly published copy. Correct indexing would need known batch membership and
coordination across all target locks, plus current validation. The scoped API below supplies the required target-lock coordination; standalone
saving retains the first fresh scan.

## Two hundred publisher directories: remaining cost

A separate three-pair group added 196 managed empty publisher directories with
the same source markers used by the publisher, keeping the four target feeds and
12 target bodies. This group ran 2026-10-18 17:09:53–17:19:10 UTC. Host browser
and full-server regressions overlapped later samples; it was not an idle host.
P95 with only three samples is the maximum, not a precise tail estimate.

| Directory-stage scenario      | Old P50/P95 ms | New P50/P95 ms | Root discovery scans old/new |
| ----------------------------- | -------------- | -------------- | ---------------------------- |
| First 12 articles             | 37043 / 38686  | 17942 / 18529  | 24 / 12                      |
| All 12 skipped, warm analysis | 17883 / 21888  | 17269 / 18490  | 12 / 12                      |
| 12 skipped, 2 new             | 24401 / 28629  | 20527 / 22754  | 16 / 14                      |

The large difference between four and 200 publishers, and the still-present 12
fresh discoveries in the all-skipped case, show the unresolved filesystem-scan
cost. Pure analysis reuse does not solve that remaining 17-second median. This
change improves duplicate work and memory but does not complete the large-scale
incremental-export latency goal. The separate scoped implementation and measurement below address that remaining
scan bottleneck; the earlier table is retained as phase-one evidence.

All 18 scenario results had the expected new/skipped statuses. Markdown and PNG
hashes matched across implementations. Stage sizes were 408,766 bytes for first
and skipped cases and 475,822 bytes for the few-new case in both versions. Sampled
RSS P50 before/after was 164.44/160.91 MB for first export, 165.04/120.03 MB for
all-skipped and 169.17/121.04 MB for few-new. These process samples include runtime
and GC behavior; they are not an exact allocation attributed to the media cache.

This measurement group overlapped the review hardening that freezes lock-identity
primitives and retains the pending-media validation short circuit. Fixture items
have stable identities and valid available media, so the measured directory,
validation and cache work is the same, but the whole group must not be described
as a byte-identical frozen-source performance run. Final fixed-source regression
and CI establish correctness; production/browser ZIP acceptance remains separate.

## Fixed-member batch scope

`LocalArticleStore.withRetainedBatch(identities, confirmedDirectory, run)` is an
internal callback API. `identities` contains at most 64 lightweight
`PreparedArticle` identities. The callback receives a dedicated scoped store; it
must await the saves it starts. An accepted in-flight save is drained before lock
release even if the callback returns early. The scoped store rejects unknown
members, another root, nested scopes and calls after scope completion.

The API freezes article/source/feed primitives before any await, sorts the exact
existing `.wewe-save-*` lock paths and reserves every target without waiting for
an occupied key. Failure releases all acquired locks, so two batches cannot
wait on one another in a cycle. While the target locks are held, it streams one
managed-directory enumeration into a bounded candidate index. More than 2048
visited directories or 1 MiB logical path/entry weight selects the full fresh
scan fallback; it never uses a truncated index. New publisher directories created
by a scoped save are registered, with the same storage budget. The index is
invalidated at scope exit and never reused by another batch.

Each save still validates the actual directory boundaries, current source markers,
article receipt, Markdown and image files through the original receipt validator.
Repair retains the original receipt-byte compare immediately before publication.
Legacy identity/source matches and multiple-copy ambiguity remain checked. The
index stores candidate locations rather than successful file-validation results.
No mtime is used as proof of completeness.

All sourced writers in this version obey the same root identity lock, including
preparations that supply their identity only after staging. Late-identity writers
freeze their actual result, acquire the root lock and perform a fresh lookup;
they do not reuse the batch index. A competing scoped target returns `SAVE_BUSY`
in the same process or another cooperating process. Different IDs remain free to
publish. Older releases with a late-identity path that does not obey this protocol
cannot safely write alongside an indexed batch. This API requires the existing
single active release/production writer gate; it does not claim safe mixed-version
multiwriter operation, or exclusion of manual filesystem changes outside the
application's lock protocol.

### Scoped 200-publisher comparison

A separate alternating three-pair run on the same 200-directory, 12-body synthetic
fixture ran 2026-10-18 17:26:44–17:32:20 UTC. Old values are from this comparison,
not copied from the earlier run. As before, P95 with n=3 is the maximum and host
browser/server verification overlapped the measurements.

| Directory-stage scenario      | Old main P50/P95 ms | Scoped P50/P95 ms | Root discoveries old/scoped |
| ----------------------------- | ------------------- | ----------------- | --------------------------- |
| First 12 articles             | 34328 / 34658       | 2262 / 2708       | 24 / 1                      |
| All 12 skipped, warm analysis | 13462 / 15214       | 1579 / 1683       | 12 / 1                      |
| 12 skipped, 2 new             | 19624 / 24714       | 1900 / 2105       | 16 / 1                      |

All Markdown/PNG hashes, output sizes (408,766 or 475,822 bytes) and expected
new/skipped statuses match. Sampled RSS P50 before/scoped is 164.59/162.94 MB for
first export, 166.76/108.23 MB for all-skipped and 172.28/112.79 MB for few-new.
The repeated directory-discovery bottleneck is removed for the scoped batch.
The remaining roughly 1.6-second skipped batch includes one 200-directory index
and 12 real receipt/file/image validations. It does not establish a 500 ms goal
for that whole batch, and measures neither ZIP compression nor browser transfer.

This group overlapped non-algorithmic lock-holder lint cleanup and the final
late-identity cooperation hardening. All fixture saves supply early identities,
so the late path is not part of these timings. Do not describe the entire group
as a byte-identical frozen-source run; final-source safety regressions and the
separately labelled frozen-source single-sample check are the appropriate
additional evidence. No production data or real upstream was used.

Final frozen-source single-sample confirmation after the late-identity and frozen
root fixes gave 2696 ms first export, 1954 ms all-skipped and 2337 ms few-new;
all root discovery counts were one and statuses/content hashes remained identical.
This is n=1, not a new P50/P95 group. Remaining physical file validation cost and
concurrent host I/O still matter. The scope API is not a promise that ZIP transfer
or a full 12-item batch finishes in 500 ms.

Runtime entrypoint audit for this integration found only the router ZIP,
single-article local save and local batch helper constructing `LocalArticleStore`;
all use `prepareCachedArticleLocalExport` with `exportSourceFromFeed`. There is no
active unsourced publisher route on this main-based candidate. The retained
unsourced compatibility API is outside the indexed batch concurrency guarantee;
future callers must supply a trusted feed identity or add corresponding lock
coordination before enabling such a route. Historical unsourced/mixed-version
writers must not be run alongside the active release.
