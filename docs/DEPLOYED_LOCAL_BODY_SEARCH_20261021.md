# Local search on the deployed baseline

Main PR80 and PR81 provide the documentation/baseline and cached-body search.
The installed app has an independent reading, selection and startup baseline.
This adaptation starts at deployed source `48fdf73f4d770001bbb6de3e2383189811e56ccb`
and transfers only the search behavior reviewed at
`b0ad33919367ce79a764814d2116a30ebf03792f`.
It does not merge the entire deployed-source branch into main or replace the
installed UI with main's different reading layout.

The search helper, projection migration, input constraints and list-page code
are the reviewed implementation, including the atomic source-body snapshot
guard against deletion and same-ID recreation. The existing router keeps its
other procedures; only search status/preparation, filtered summary/list and
filtered directory export use the new search helper. The existing UI retains
its reader, date formatting, persisted sort, loaded-only selection and export
controls, adding coverage, stop/resume and React text snippets.

Migration 20 is already installed on the local app and is included unchanged
for reproducible fresh packages. Migration 21 adds only a rebuildable derived
table, indexes and synchronization triggers. It does not modify old article,
subscription or account rows. Extraction is outside collection transactions.
Uncached bodies are explicitly excluded; preparation never fetches an article.
No AI, vectors, external transfer, Sites or new platform integration is added.

The frozen deployed safety manifest remains unchanged. A narrowly enumerated
overlay pins the two search/list helpers and five article routes. The original
reader, login, collection, backup, write coordinator and startup fingerprints
continue to be checked. Existing synthetic migration fixtures use the tested
SQLite statement splitter because trigger bodies contain semicolons; no old
business or audit assertions are removed.

The deployed-only `article.exportIds` also uses body-aware matching for a
nonempty search. This makes current-filter Obsidian identity discovery agree
with list/summary and filtered directory export, including body-only matches.
It retains the 5001-row probe, rejects more than5000 identities, orders by
publication descending/identity ascending and returns a frozen identity array.
Direct actual-SQLite regressions cover body-only and mixed title/body matches,
publisher/group/date intersections, invalidated body exclusion, frozen results
after a later body update, and the existing export cap. Selected-ID export
continues to use its existing explicit membership.

Windows lifecycle CI uses the installed, frozen Node 24.11.1 runtime. The
floating Node 24 job resolved to 24.22.0 and refused copying into an already
reserved empty directory before the original lifecycle assertions ran. The
unchanged 21-test installer suite passes locally on 24.11.1. This pins the
supported release target; it does not claim compatibility with newer runtimes
or change any installer/release guard to accommodate them. The existing list
HTTP fixture also accepts authenticated POST preparation, matching the main
search fixture while retaining pagination and fault-injection assertions.

Release checks use fresh synthetic databases, exact source/package identities
and a controlled single-writer transition. The user authorized in-place
additive migration and local extraction but prohibited whole-database copies.
Release rehearsal and preservation checks must respect that boundary; generic
restart tools that automatically copy the database are unsuitable for this run.
Rollback may change only program files/pointer after checking compatibility
with the additive schema; it must not restore an old database or remove articles.

The historical performance report remains attributed to its original measured
version and synthetic cohorts. It is not a new performance measurement of
this adaptation. Local production acceptance, stop/start times and exact final
version belong in the private release record, never in committed article data.
