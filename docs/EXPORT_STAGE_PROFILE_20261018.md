# Incremental export stage follow-up

This branch starts from frozen PR71, `4862fd3a7d7a11a20e783454c7ecd317d7060237`,
whose only parent is deployed source `8a3141c43b1b09e92ebd75780f26c58939557906`.
PR71 is retained unchanged. This follow-up has no production or upstream operation.

## Separate workloads

The 128-article **all-skipped** workload rechecks existing saved receipts, notes,
publisher/group identities and image bytes. It does not convert Markdown or write
article bodies/images. It creates and releases the existing identity lock files.

The 512-article **offline directory construction** workload starts in an empty
self-created export directory. It selects IDs, reads cached bodies in groups of 8,
converts HTML to Markdown, writes staged Markdown/images, validates and publishes
them, writes receipts and the archive README, and removes its staging files. It
does not include ZIP compression or HTTP transfer. It is a first-save workload,
not the same workload as all-skipped incremental export.

## Stage evidence before changing runtime

An opt-in, synthetic-only profiler records nested method spans and filesystem
calls. It stores no paths, article IDs or content. Its exclusive wall partition
counts overlapping asynchronous spans once; inclusive method totals overlap and
must not be added to filesystem totals. Instrumentation is capped at 200,000
spans and reports overflow explicitly. No production instrumentation is installed.

Single diagnostic samples on PR71 (n=1; no P50/P95 inference):

| Workload            | Total ms | lstat count / exclusive ms | readFile exclusive ms | Body preparation                                                      |
| ------------------- | -------: | -------------------------: | --------------------: | --------------------------------------------------------------------- |
| 128 all-skipped     |  4710.91 |             6716 / 2820.57 |               1332.34 | 0 media recomputations; cached facts 13.75ms                          |
| 512 first directory | 58021.99 |           85965 / 34042.53 |               6404.00 | Markdown + image preparation 2910.26ms inclusive; 1718.56ms exclusive |

The earlier PR71 n=3 measurements (6.59s skipped P50, 77.07s directory P50) ran
under different shared-host load. They identify the workloads but cannot be
subtracted from these diagnostic samples to attribute a performance change.
Filesystem metadata is the main observed cost; repeated HTML parsing is a smaller
cost. Warm skipped articles already avoid reparsing media facts.

## Minimal changes and invariants

- Offline directory construction now uses the existing fixed-member 64-article
  retained index scope. Bodies remain in groups of 8 and order/membership stay
  frozen. Missing bodies still produce explicit incomplete entries. Cancellation
  and all exceptional exits drain operations and release the same identity locks.
- Every ancestor path component is still checked afresh with `lstat` before the
  filesystem operation. At most 8 metadata checks run together, all settle before
  return/rejection, and failure order follows path order. A redundant immediate
  group walk is removed only where the folder walk checks that same group and all
  its ancestors without an intervening filesystem operation. No successful file
  checks are cached, no symlink checks are removed, and no lock scope is reduced.
- Markdown conversion reuses its already-loaded, unmodified document for the
  existing media-uncertainty predicate. The DOM dies with the conversion. The
  existing bounded, content/status-keyed media-fact cache and all byte checks remain.

Receipt schema, user-note preservation, image hashes, CAS, pending receipt
recovery, grouping/title/source rules, directory conflict handling, backups and
Prisma admission are unchanged. The deployed boundary test pins every unaffected
conversion statement and the uncertainty predicate rather than pretending the
now-modified conversion file is byte-identical to deployment.

## Comparable validation

The benchmark's reviewed baseline allowlist includes PR71. When comparing its
incremental store, the old variant uses PR71's actual retained batch path, not the
older unbatched fallback. Each old/new variant loads a separate pinned local
module graph and runs in a separate process. Only self-created synthetic Temp
directories/databases are accepted; cleanup runs in `finally` after root checks.

The draft PR records final alternating old/new n=3 results at 128 skipped and 512
first-save articles, sampled heap/RSS, output/status hash equality and exact CI.
These measurements retain all file checks. They do not establish a universal
150ms/500ms bound or validate a production request.

## Independent reading ownership (outside this follow-up)

- First list backend: `apps/server/src/article-list-page.ts`,
  `article-list-cache.ts`, `article-list-read-timing.ts`; only router members
  `article.list` and `article.summary`. Preserve authorization, write admission,
  single-connection policy and revision-token semantics.
- First cached body: router `article.byId`,
  `apps/web/src/components/ArticleReader.tsx`, and `article-reader-find.ts`;
  distinguish database/HTTP, Blob creation and iframe load.
- Frontend list/query scheduling: list/summary/byId query sections in
  `apps/web/src/pages/feeds/list.tsx` and `use-article-list-position.ts`.
- `list.tsx`, `provider/trpc.tsx` and router are shared files requiring member-level
  coordination. This follow-up owns only router `buildOfflineFeedDirectory`,
  `article-local-save.ts`, `article-export.ts` and related tests/benchmarks.

Release still requires exact-head CI, review and the single production owner's
integration/rollback and separately authorized end-to-end acceptance.
