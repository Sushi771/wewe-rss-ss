# Delivered backup, media, export and reading changes on main

This candidate starts from main `c9ba967292a6d408eabe9560a943349bb25ebdfc` and extracts selected behavior from the locally deployed source `c80d240f4decee45bd00ff49c190da91b7670c3f`. It is a separate review candidate. Its build and CI do not constitute permission to merge, deploy, enable a flag or retire a recovery point.

## Included behavior

| Area                   | Main entry points                                                                                    | Source consistency                                                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Periodic backup        | `backup-sqlite.py`, `sqlite-snapshot-guard.py`, TS guard/root, release packaging and budget forecast | Runtime files match c80. Persistent daily cadence, three normal plus at most one pending point, uncertain-result holds and explicit retirement protection remain. |
| Automatic image repair | cache-sync service/engine, bounded media queue/scan and saved-body writer                            | Core modules and the selected collection/service methods match c80. Incremental write, transaction/CAS, original-fragment preservation and finite retry remain.   |
| Exact saved media      | protected `article.supplementSavedMedia`                                                             | Exact c80 local-only mutation; at most five IDs, fixed server configuration/manifest binding, no client paths or HTML.                                            |
| Future exports         | existing Markdown, Obsidian and offline-feed entry points                                            | Selected router methods and renderer functions match c80; source receipts, attachment identity, edited-note protection and partial-media reporting remain.        |
| Reading status         | refresh progress, local media status, startup/storage details, failed-operation toast                | Source components/helpers match c80. Main layout and routing are adapted locally. Forecast advice stays inside storage details; blocking failures remain visible. |
| Article pagination     | existing main ArticleList and position hook                                                          | Only scroll containment, loading/retry/end feedback and view-scoped next-page failure state are extracted. Main body reader, metrics and API remain.              |
| RSS                    | `feeds.service.ts`                                                                                   | Exact c80 projection: summary RSS reads only used metadata; full-text mode remains unchanged. No readiness timeout increase.                                      |

## Deliberate main adaptations

- Main keeps its existing routes, login, compatibility schema and migration history. No schema, PrismaService, shared incremental-write or write-coordinator change is included.
- `/tools/article-download#storage-backup` is retained as the deployed details-link target, but this slice serves only a small storage-details page. The general download form, verification adapters, XHS downloader and other tool routes are absent.
- The export renderer imports an export-only metrics helper containing the exact c80 function. Main's existing collection reports keep their prior metrics behavior. The local-save helper uses a small standalone error class, avoiding the network downloader dependency.
- The retention helper omits only the unused `automatic_after_snapshot` function. All retained protocol functions/classes and the explicit action/path/hash/identity/handle/approval checks match c80. No history application or automatic-retirement framework is introduced.
- Main's existing two-argument offline controller continues to work. Internal optional filter/cancellation parameters are retained with the exact source method; no `exportIds` or new filter/frozen-ID public endpoint is connected.
- Main's search, sort, body reader and bounded position utility are retained. This change does not import the integration branch's broader folder/date-filter page or claim identical page structure. The browser regression exercises the actual list/provider/router using main's height and scroll boundaries.

## Verification and evidence boundaries

`scripts/main-wechat-runtime-scope.test.cjs` binds the manifest to the exact source and main SHA, checks every collection/service class member, keeps unrelated router members and article routes at main hashes, and verifies unchanged shared safety files. Only the specifically selected source methods/routes have new expected hashes.

Synthetic coverage includes native Windows lifecycle and exact retirement approval, interrupted media commit/CAS/rollback/no-network boundaries, local-save junction and edited-note protection, export content/attachment bytes, pending-media receipts, RSS compatibility and startup pool pressure, fresh/existing database compatibility, and actual authenticated HTTP pagination in a browser. The browser checks three complete pages, missing-page retry, retained prior rows, bounded restoration and reachable controls on desktop/narrow/short viewports.

All development fixtures use owned temporary databases/directories. Production export acceptance remains outside this development task; no real export, upstream collection, downloaded resource access, database copy, recovery-point deletion or production write is needed for these checks. Sandbox loopback/junction failures are recorded separately from native reruns, without removing assertions.

## Operational boundaries

The cache-read contention followup is fully extracted from PR64
`a5e8f2544f7836df503794d684f5b607cccc071e`, including its benchmark compatibility
commit `f5d463f9ff3d3b47beec3e4c86f61d0eccd82756`, tests and fixtures. Only the
`syncCachedWechat2RssPage` member is adapted in main's service; the new helper
matches the source. The existing occupancy fix remains unchanged. The main CI
also runs the frozen-legacy-SQL scheduler comparison with its baseline history
available, rather than attempting to scrape SQL removed from the runtime.

Cache flags now use one statement over the current page's saved IDs. Healthy
inline bodies return flags only; ambiguous image attributes use a bounded linear
probe after the connection is released. The total 8,000,000-byte probe limit
keeps oversized/deferred cases pending. See
[the contention analysis](CACHE_PREFLIGHT_READ_CONTENTION.md) for synthetic
evidence and its limits. No connection, timeout, transaction, CAS or list-cache
policy is relaxed; production concurrency acceptance remains with the release
owner at the original RSS threshold.

The preparation-occupancy followup from
`e6600122d64aaa541dc92a4b97491601537135cd` changes only
`coverPreparation` in the shared batch manager. Retry coverage now uses the
current persisted intent, creation time and admitted source digest with the
existing `occupiesUnknown` predicate. A released old unknown cannot reoccupy that
bound future retry; different/missing source, same intent, invalid release/time
binding, a new unknown or active accepted-cache work still holds it. Historical
unknown records remain unchanged. The source manifest records this explicit
followup instead of changing unrelated main hashes.

Periodic lifecycle remains default-off unless explicitly configured and initialized for the intended source/root. Turning it off after initialization holds safely. Ordinary media commits stay incremental; first upgrade/startup protection and destructive actions keep their recovery gates. A pending recovery point can still hold a high-risk action that needs a new protected copy. Capacity forecasts retain the configured cadence and hard cumulative budget.

Enabling production behavior, changing its configuration, deploying this candidate, deleting a recovery point and merging to main require the production owner's separate release decision. Existing live deployment and natural-update acceptance are managed outside this PR.
