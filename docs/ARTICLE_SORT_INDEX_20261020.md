# Global article ordering index

Global article pages already select narrow IDs before hydrating metadata. They
still scan and sort the article table when ordering by publication time and ID.
The additive migration adds only `(publish_time, id)`. It preserves the existing
ascending/descending order and cursor contract, and leaves the single-publisher
index in place. No query, list cache, summary, body, export format, compression or
runtime configuration changes.

## Synthetic comparison

From `apps/server`, with locked dependencies and the generated Prisma client:

```sh
node -r ts-node/register/transpile-only scripts/benchmark-article-sort-index.ts
```

The benchmark accepts no database or output-directory argument. It creates new
temporary databases, applies the repository migrations, seeds 300 synthetic
publishers with 1 KiB body text per article, and compares five alternating
indexed/unindexed samples. It executes the actual `findArticleListRows` and
Prisma cursor SQL without the optional page cache. Setup and connection warmup
are excluded. Temporary synthetic databases are retained. Report output is local
evidence, not a production audit to upload.

Windows / Node 24.11.1 results, milliseconds (median; maximum in parentheses):

| Articles | Operation                    |          Before |         After |
| -------- | ---------------------------- | --------------: | ------------: |
| 1,809    | First page                   |     6.19 (6.77) |   3.53 (4.08) |
| 1,809    | Middle cursor page           |     5.78 (6.39) |   3.01 (3.35) |
| 60,000   | First page                   | 103.04 (119.76) |   3.47 (4.45) |
| 60,000   | Middle cursor page           |  94.69 (105.19) |   5.01 (6.93) |
| 1,809    | 100 inserts, one transaction |   47.62 (52.03) | 48.66 (51.91) |
| 60,000   | 100 inserts, one transaction |   48.63 (49.45) | 48.90 (54.96) |

Page timing includes transaction admission, ID ordering, metadata hydration and
body-presence lookup. It excludes filesystem export, HTTP, browser transfer and
drawing. This is not a measured improvement to click-to-visible latency. The SQL
plan changes from table scan plus temporary B-tree to covering-index scan.
Small warm pages have little absolute time to save.

Index creation median/max is 7.49/9.24 ms for 1,809 articles and 122.60/138.38 ms
for 60,000. Index pages occupy 53,248 and 1,376,256 bytes respectively. Creation
holds a write lock and requires disk space; schema engine startup, production
backup/rehearsal, large real bodies, fragmentation and concurrent writers are
outside these measurements. Inserts maintain the additional index. Five samples
do not establish a universal write-cost limit.

The index does not accelerate arbitrary substring searches. A miss or an old
match can still scan many rows; no full-text substitution or search-semantic
change is included. The existing four summary queries are unchanged. Earlier
slow diagnostic SQL that manually combined summary expressions was not the
product's actual query path and is not used as evidence for this patch.

## Export preflight evaluation

An existing complete receipt is not proof that current database HTML contains no
new image. Receipts have image mappings but no reliable database-body version.
The existing saver analyzes current cached media, reuses verified files and can
write a companion note for later images while preserving user-edited Markdown.

Therefore a metadata-only preflight was not retained: it cannot prove the same
skip decision when HTML changes, a receipt is incomplete, files are missing or
media needs repair. This change makes no claim of a new export speedup. The
existing bounded body reads and retained-directory batches remain intact.
Avoiding their body transfer safely would first require a trustworthy content
version/proof across all writers and a measured end-to-end benefit; that larger
data/receipt migration is outside this additive-index change.

A new regression starts with a complete one-image receipt, edits the original
note, then adds a second image in cached HTML. It requires a repair, exactly one
new image request and preservation of user notes. Existing regressions cover
null/missing bodies, incomplete receipts, missing/modified media, interrupted
publication, partial failure, cancellation and safe repair. These are synthetic
tests with network mocks, not real upstream collection.

## Migration and release boundary

The existing 19 migrations remain unchanged. Fresh databases apply 20. Tests
upgrade both the historical 12-migration main layout and the 19-migration deployed
layout, preserve rows and historical checksums, and verify repeat deploy is a
no-op. Text source pins normalize Windows checkout line endings; actual database
migration checksums are compared against the raw applied bytes.

Focused commands:

```sh
pnpm --filter server exec jest article-sort-index article-list-page article-incremental-export --runInBand
node --test apps/server/scripts/test-main-schema-compatibility.cjs
node --test scripts/main-wechat-runtime-scope.test.cjs
pnpm --filter server exec tsc --noEmit
```

The branch starts from main `9c034c86a195bed9492871f9ccb1ab3a5b36b6d1`.
The separately installed application has different frontend/export adaptation
ancestry; do not replace its code with this main checkout. A later approved local
release must adapt this index-only migration to the exact active source, verify
schema/history/backup compatibility on isolated synthetic layouts, plan write
lock and disk headroom, then obtain approval for the production migration and
release. This development task does not apply an index to any production database,
restart a service, deploy or merge a pull request.
