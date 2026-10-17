# Scoped main schema and article-filter compatibility

This prerequisite starts from main `7f392f85865491d685f14fb16e5f0b27286374ac` and addresses two compatibility failures found while preparing the accepted WeChat refresh/list fixes from `aeb7483c85db8d13f1345011266ae7ee6046adc0`.

The current main schema strips the deployed `group`, `dateStart`, `dateEnd` and `direction` list inputs. The existing grouping migration also refers to `xhs_creators`, so copying only migrations whose names look like WeChat fails on a new database. Editing that already-applied migration would change its checksum.

## Included scope

- Preserve the deployed Prisma schema and all 19 historical migration files byte for byte. Seven migrations are added relative to main; the existing 12 are unchanged. The fixed source SHA and SHA-256 manifest are in `apps/server/scripts/fixtures/aeb-schema-compatibility.json`.
- Retain XhsCreator/XhsNote table definitions and their grouping/video metadata as historical database compatibility. On a fresh database these tables are empty. Existing opaque rows are retained on upgrade. This is explicitly disclosed schema compatibility, not an enabled Xiaohongshu feature.
- Preserve the original management-group foreign keys, ordering and lookup indexes, cache-insert ledger, cache-refresh receipts and refresh-submission claim tables. No table is dropped or rebuilt by the seven added migrations.
- Reuse the deployed date and article-filter helpers. The actual list and summary routes apply group/search/source/date scope; publication ordering supports both directions with the original ID tie break. Metric sorting remains descending. Invalid dates, reversed ranges and invalid directions are rejected rather than stripped.
- Reuse the deployed protected one-article import schema adapter and its regression tests. Known historical layouts are captured in full, including grouping, BLOB bytes, INSERT receipts, refresh commits and unknown claims. Unexpected tables or malformed ledger layouts still fail, and no historical row is exempted from drift checks.

The XHS service/router, collection/provider activation, account credentials, download endpoints, frontend navigation and prototypes are not introduced. Rnote and paid prototypes are also excluded. No new backup cadence, copy-count policy, retirement behavior or daily-backup branch is included. The main README is unchanged.

## Boundaries

This is a schema/filter prerequisite, not the complete aeb runtime. It does not activate persistent refresh workers, old-occupancy release, response-proof recovery, article-list performance helpers or observation hooks. Those require separately scoped integration and exact-target validation. There is no deployment or main merge in this change.

The compatibility work stays below the earlier 21-file core-module boundary and does not transfer the 149-module application closure. The existing route change is limited to list/summary filter construction in `TrpcRouter`. The virtual all-feeds RSS metadata also supplies `groupId: null` to match the additive Feed model. Existing refresh, subscription, export, account and backup handlers are retained.

## Validation

`node --test apps/server/scripts/test-main-schema-compatibility.cjs` uses a newly generated client from the candidate schema and only owned synthetic SQLite files. It checks the immutable migration manifest before constructing fixtures. No production database, backup or private environment file is used.

The fixtures cover:

1. A fresh empty database: all 19 original migrations apply and compatibility tables are empty.
2. An existing deployed-schema database: original migration checksums, account/article bodies, grouping, compatibility records, refresh commits and an unknown claim survive a no-op upgrade unchanged.
3. An existing main-schema database: the original 12-migration prefix upgrades additively; original accounts, article bytes and migration rows remain unchanged.
4. Application registration: no XHS, Rnote or paid entry point is added.

The actual tRPC caller/SQLite tests cover Shanghai day boundaries, group and ungrouped membership, source/search intersection, list/summary agreement, ascending cursor ties, metric zeros, legacy inputs, authorization and invalid-filter rejection. They do not send upstream or download requests.

The first Windows fixture run passed its four compatibility assertions but failed cleanup because its generated native DLL was loaded inside the owned fixture directory. The fixture now reuses the installed native engine from outside that directory, retains the same freshly generated model/client and restores its temporary environment setting. The failed run is not counted as successful validation.

The first exact-head CI also exposed the old protected import tool's four-table schema allowlist. Its image-import job failed with `SQLITE_SCHEMA_UNEXPECTED`. The follow-up includes the already deployed adapter and preservation tests from aeb, rather than skipping the image job or removing its strict old-row/ledger assertions.

Development tests and synthetic upgrade paths do not establish production acceptance. The scheduled natural-refresh acceptance and independent review remain prerequisites for any later main merge; creating a draft PR does not authorize a deployment.
