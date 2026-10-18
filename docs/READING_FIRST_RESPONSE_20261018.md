# First list and cached-body response

The export optimization is frozen. This reading-only follow-up starts at
`7a99f2c6e003b1ecf029e61f0d2031b05c05afaa` (PR72), which is compatible with deployed
source `8a3141c43b1b09e92ebd75780f26c58939557906`. No visual simplification or
production operation is included.

## PR dependency and later release sequence

| Candidate                                        | Base                                            | Role                                                                                   | Integration rule                                                                                          |
| ------------------------------------------------ | ----------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| PR70, `6b778e7d9cfa25daef4ed54239c4147a11fd3f9b` | main `33ec7c3ebc20ce55d5f81259a5dd515912b5ca65` | Original reading-cache/export implementation                                           | Reference implementation only for the deployed-source stack; do not also merge/cherry-pick it after PR71. |
| PR71, `4862fd3a7d7a11a20e783454c7ecd317d7060237` | Deployed `8a3141c…`                             | Selective compatible adaptation, preserves deployed reader/group/title/source features | First export/cache prerequisite. It already carries the selected PR70 behavior.                           |
| PR72, `7a99f2c6e003b1ecf029e61f0d2031b05c05afaa` | PR71                                            | Export stage optimization and tests-only browser-scroll follow-up                      | Apply after PR71. Runtime change is `46c1886…`; retain both commits for its tested final head.            |
| This reading follow-up                           | PR72                                            | Independent reading responses; server SQL remains frozen                               | Apply after PR72; its final SHA/CI and reading measurements are recorded in its own draft PR.             |

Future reviewed order is `8a3141c → PR71 → PR72 → reading follow-up`, not
`PR70 + PR71`. Prefer preserving this ancestry. Squashing/cherry-picking would
require checking duplicate changes and rerunning exact integration tests. The
single release owner must still choose an approved complete candidate, keep a
rollback, and separately verify the production chain. These instructions are
handoff guidance, not a merge/deployment operation.

## Read path and measurement boundaries

- `article.list`: authorized query → revision-header check → bounded page cache
  hit or one coordinated read transaction → narrow ID selection → current-page
  metadata/feed hydration → current-page body-presence IDs → public status mapping
  → JSON/HTTP → React rows. The unseen cursor row remains part of the existing
  pagination protocol; no skip, ordering, position or error behavior changes.
- `article.summary`: authorized query → coordinated read transaction → matching
  metadata aggregates plus body-null count → small JSON → statistics. Counting
  matches is not selecting/parsing every article's HTML. In particular, do not
  replace the body-null predicate with `COUNT(content_html)`, which can read large
  body values unnecessarily.
- `article.byId`: authorized query → one primary-key read of the cached row →
  status mapping → JSON/HTTP → current reader → Blob document → sandboxed iframe
  load. It does not call retry, refresh, image fetch or export. A cache miss remains
  an explicit status; only the user's existing retry action can initiate retrieval.

List SQL/cache, revision token/WAL/journal bypass, PrismaService admission,
single-connection policy, reader DOM/CSP, all controls/layout and existing cache
staleness remain intact. No new cache or index migration is required.

The diagnostic script uses a self-created6000-row/200-feed SQLite database with
32KiB bodies and actual PrismaService wrapping at `connection_limit=1`. Seeding
uses a separate client before measurement. Sequential requests permit native SQL
durations to be assigned to that request; middleware spans inside an array
transaction overlap and must not be summed. The synthetic database's OS pages
are warm after seeding. Neither an idle synthetic coordinator nor a warm file
reproduces production connection contention or cold storage.

Five baseline HTTP samples per phase: list miss21.32/85.71ms P50/P95, list hit
5.42/6.64ms, summary22.88/38.67ms, cached32KiB byId4.65/8.46ms. The first miss
includes initial route/client work. This does not show a need for another body
cache or a new list SQL algorithm.

An installed-client/local-HTTP test holds an unrelated background procedure for
300ms in the same batch. The old provider isolates list only; summary and byId
wait for the held batch despite their own work being ready. This is a controlled
head-of-line case, not a claim that every ordinary first open has this delay.

The final runtime change only isolates `article.summary` and `article.byId` on
the existing authenticated HTTP link, as `article.list` already was. Query
staleness, retry, abort signals and errors are unchanged. No reader/list DOM,
SQL, startup, backup or write-admission code is changed.

A two-query summary prototype combined numeric non-null counts in one aggregate.
Although real SQLite correctness tests passed, alternating same-database n=5
measured summary P50 22.63ms → 129.89ms and native SELECT time about17ms →126ms.
It was reverted before commit. The original four-query null-predicate version is
retained. Reducing statement count alone was not a valid optimization. This
rejected prototype does not form part of the final candidate's measurements.
Synthetic EXPLAIN also distinguishes the two forms: its numeric column-read
instruction has flag0 for value counting and flag128 for the null predicate.
The native timing regression is measured; the fraction specifically due to
overflow-page access is not independently attributed.

The byId backend was already a few milliseconds. Initial browser decomposition
was about50–64ms click-to-headers, less than1ms headers-to-JSON,28–52ms
JSON-to-Blob (including React scheduling/rendering),18–29ms Blob-to-iframe load.
These are wall intervals, not claims of CPU time in Blob creation. A separate
browser microprobe put40 warm date-formatter constructions around4–5ms; no broad
reader rewrite or additional data cache was justified by that small isolated cost.

Browser measurements retain actual components and styles. Each first-body
sample evicts only the fixture's inactive byId query so it really reads the
cached database body; the warm-body sample retains the query. HTTP headers,
JSON completion, Blob creation and iframe load are recorded separately. Iframe
load does not mean every remote image has decoded. Only local application
requests are allowed; fixtures contain no private data and are finally removed.

Final same-method before/after tables and exact-head CI belong to this reading
draft PR. They must not be mixed with PR70/71/72 export results or earlier browser
samples that did not explicitly evict inactive byId entries between first reads.

The final ordinary page comparison does not show a clear speedup: n=5 first-row
observer P50/P95 177.27/210.51ms →170.88/219.88ms, and in-page first-body
click-to-iframe-load92.80/110.70ms →109.40/113.60ms. The controlled batch-blocking
case is the demonstrated improvement, not a faster SQL/body cache. For this warm
synthetic fixture, provisional reference budgets are first-screen observer P95
250ms and cached32KiB iframe-event P95200ms; these are not universal150ms promises
or production acceptance. The automated observer includes CDP/polling overhead
and must not be substituted for the in-page event interval.
