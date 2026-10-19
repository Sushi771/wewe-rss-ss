# Main export and reading follow-up

This independent follow-up starts at the exact [PR70](https://github.com/Sushi771/wewe-rss-ss/pull/70)
head `6b778e7d9cfa25daef4ed54239c4147a11fd3f9b`, whose base is main
`33ec7c3ebc20ce55d5f81259a5dd515912b5ca65`. PR70 is a prerequisite: merge it
first, then review this delta against main. Do not add PR71, or merge the whole
deployed-source branch into main. At initial inspection PR70 was still open and
draft; this work does not change its head/base or perform its merge.

## Correspondence and main differences

The reference behavior is PR72 `7a99f2c6e003b1ecf029e61f0d2031b05c05afaa`
and PR73 `6b7afe8fb7ef84f22684601cd088487c3de3904f`, built on deployed
source8a through PR71. Only these four runtime files change relative to PR70:

- `article-local-save.ts`: check fresh directory ancestors with at most eight
  simultaneous lstat operations; drain before returning/rejecting. The complete
  leaf walk already checks its group ancestor, so remove the immediately repeated
  group walk. Do not cache successful path validation or weaken link checks.
- `article-export.ts`: reuse the current unmodified Cheerio document for media
  uncertainty instead of parsing the same HTML twice. Preserve incomplete/unsafe
  image status, sanitization, Markdown and relative-media behavior.
- `trpc.router.ts`: the existing ZIP-directory staging operation now reuses its
  retained discovery scope for at most64 fixed members at a time. Database body
  reads remain at most8, output order remains frozen, and missing/deleted members,
  cancellation and incomplete-body fallback remain explicit. ZIP compression and
  HTTP delivery are unchanged.
- `provider/trpc.tsx`: `article.list`, `article.summary` and `article.byId` use the
  existing independent httpLink. Other operations keep httpBatchLink. Preserve
  headers, auth/error handling, aborts, retries and reading-cache invalidation.

Main keeps its own `article-export-metrics` and `ArticleLocalSaveError` modules,
router APIs and UI. No deployed grouping/date/reader/startup wiring is imported.
No schema, SQL, database cache, coordinator, backup or connection policy changes.
In particular, this does not apply the rejected COUNT(content_html) experiment.
The source-boundary fixture changes only the permitted directory-staging method
fingerprint; unrelated main router members and critical safety blobs remain
checked against their previous fingerprints.

## Validation and evidence limits

Local Windows validation reuses installed dependencies and only own synthetic
directories/databases and local test HTTP ports:

- Export/path/media tests:10 suites,70 tests passed. Coverage includes every
  ancestor, concurrency<=8, draining on rejection, no validation reuse, single
  DOM parse, uncertain media, edited-file protection,64+1 retained membership,
  <=8 bodies, fixed order, missing-body fallback, deletion and cancellation.
- Root contracts:11/11 passed, including main source boundaries, reading-cache
  budget and batch receipts. The installed-provider predicate is compared to the
  actual PR70 source, not merely an assumed old predicate.
- Controlled transport, five alternating samples per variant: a synthetic
  background procedure is held300ms. Cached-body response P50/P95 falls from
  326.09/377.24ms to7.37/10.24ms; summary from326.09/377.28ms to7.86/10.99ms.
  Auth rejection and request abort are also exercised. These are controlled batch
  waiting measurements, not normal browser opening or production latency.

Earlier PR72 export timings and PR73 production-compatible fixture results are
historical reference evidence, not newly measured main results. This adaptation
claims equivalent bounded work and removal of batch waiting, not a universal
150ms target or a measured full-export/browser speedup on main. Exact-head CI and
the final browser/type/lint results belong in this follow-up PR's delivery record.

The first root-contract run failed only because its new method fingerprint was
calculated before formatting changed a string token. It passed after recomputing
that one fingerprint against normalized final source; the failure log is retained
privately. No production service, real database, upstream platform, backup,
deployment or restart is used to validate this change.
