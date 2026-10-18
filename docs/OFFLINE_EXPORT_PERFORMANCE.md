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
The fixture has 32 cached articles, roughly 128 KiB text per body and one inline
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
