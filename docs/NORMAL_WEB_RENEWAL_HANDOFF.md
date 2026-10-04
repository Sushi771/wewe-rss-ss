# Normal Web renewal and reviewed continuation

Day-two boundary was checked without HTTP or private-file writes: the reviewed authorization rejects time after the actual22:31:41 UTC expiry. The production manual-refresh provider does not call normal renewal; maintenance utilities are integration helpers, not an automatic renewal service. After actual expiry the owner must use normal account login and explicit preview/connection through existing UI. Do not extend expiry, repeat the successful renewal now, remove old stops or mix credentials. The current b3161eb deployment only adds verified saved-article export, which does not need platform authentication; see [real cached save](VERIFIED_CACHE_SAVE_ACCEPTANCE.md).

Current integration status (2026-10-04): one authorized ordinary renewal at21:01:41 UTC succeeded for the same account, with real conservative expiry22:31:41 UTC. No repeat renewal or artificial extension occurred. PR9 time semantics and the existing-body image supplement are deployed as application802a7b5; the latest10 real bodies/images and original-route repeated deduplication passed. See the [actual acceptance](LATEST_TEN_IMAGE_ACCEPTANCE.md). The source-worker fixture report below is historical and does not replace these real integration results; all old stops and original scan evidence remain preserved.

The integration owner's ordinary Web renewal returned HTTP 200 / `succ=1`, an
explicitly matching account and new authentication cookies. Its response omitted
Secure, added the existing allowlisted `wr_pf` and supplied finite server expiry.
The old adaptor discarded that expiry and changed the human scan time; the
ordinary response jar rejected those renewal attributes. These defects are fixed
using the existing bounded cookie parser, with a dedicated successful-renewal
mode. Ordinary directory/body response policy remains unchanged.

This worker used only the provided synthetic fixture matching the saved server
attributes. No platform request, live cookie activation, production write,
deployment, stop deletion or human login was performed. A successful renewal
does not establish real latest-ten body/image acceptance.

## Pure adaptation and private candidate

`applyNormalWebRenewal(session, ownerVid, response, renewedAt, parentSessionText)`
in `apps/server/src/weread/normal-web-renewal.ts` accepts a response envelope:
`{url, status, data, setCookies}`. `url` must be exactly the fixed HTTPS
`/web/login/renewal` endpoint, status must be 200, and the business result must be
successful. Pass the ORIGINAL response receipt time as `renewedAt`, never the
offline processing time. Pass the exact saved session text for its byte hash.

The result preserves source, owner and `capturedAt`; `renewedAt` is independent.
It contains parent/result authentication and session hashes, the normalized
response-envelope hash, cookie hash and received attribute metadata. The
normalized envelope hash is distinct from the integration owner's raw response
file hash; retain both in private operational evidence when applicable.
Received Secure=false remains recorded honestly, while effective cookies retain
the stricter original client restriction. Sending still requires the fixed HTTPS
host. Host-only scope is preserved. Root/path broadening is rejected. A newly
issued `wr_pf` inherits the authentication cookie's scope; other new credential
names are rejected. Owner mismatch, missing server owner/key, unchanged key,
malformed/oversized/duplicate cookies and revoked authentication cookies fail.
Auxiliary deletions remove their credentials. Max-Age takes precedence over
Expires, using the original response time; both attributes remain in metadata.

`persistNormalWebMaintenance(...)` in `normal-web-maintenance.ts` consumes that
cached envelope under the existing `.native-login.lock` and collection `.lock`.
It checks exact current config/state/session hashes, original authorization and
the same account's first-directory `-2012` stop. It atomically creates a private
`normal-maintenance-<sha256>.json` candidate without changing any active pointer,
stop, account, QR index or profile. Partial failures remove only this invocation's
pending file. Existing records are accepted only when their bytes match.

The maintenance deadline is additionally bounded by the earlier explicit server
Expires for the key. This stricter continuation limit does not change RFC cookie
parsing. In the supplied fixture it is **2026-10-04T20:19:06Z**. Applying or
deploying the cached response cannot extend that deadline. Expired candidates
must be rejected; this change never requests another renewal.

## Explicit integration adoption

After review, a fresh read-only baseline/preflight and a verified consistent
SQLite backup, the sole integration owner may call:

```ts
activateNormalWebMaintenance({
  configFile,
  mpId,
  maintenanceFile,
  expectedMaintenanceSha256,
  expectedConfigSha256,
  approval: 'same-owner-timeout-continuation',
  approvedAt, // actual integration approval time
});
```

This utility is not exposed as a network mutation or called automatically. It
requires an unchanged original QR index, exact parent binding/state/session and
valid current expiry. It publishes a separate immutable maintained session,
retains config/state before-images and commits under both existing locks. A
config commit failure rolls back authorization only when config is provably
unchanged. It never replaces the human login file/index, scan time, account token
or profile cache. Replaying the original candidate after adoption cannot grant
another budget because its original config/state hashes no longer match.

The state retains the old stop and `manualRefreshAuthorization`, and adds a
distinct `normalWebMaintenanceAuthorization` tied to the exact old stop and new
authentication. The original local `feed.refreshArticles` path carries its
trigger to the provider. Public and scheduled triggers cannot use maintenance.
One pending local validation is consumed before its first request under the
collection lock. Interrupted/failed validation cannot be replayed. Only success
through ten verified bodies and the image archive permits later original local
manual refreshes, still under the existing cooldown and finite expiry. A new
refusal replaces the active stop and invalidates this continuation; immutable
maintenance/before-images preserve the preceding stop evidence. Captcha,
permission, unknown or other-account stops never qualify.

The account preview reads the maintained binding without moving the QR index.
Re-confirming that already adopted connection is a no-op and cannot replenish
validation authorization. Other subscriptions retain their existing bindings.

## Integration and regression

Built from committed integration HEAD `129f4c414f8aff9135c63b6e9368be8616ca3392`
in an independent worktree. PR7 commit `5abf425` is the separate login-timeout
message improvement; it is compatible and may be cherry-picked before this repair.
Neither patch by itself establishes real subscription recovery.

The committed fixture contains synthetic values only. Regressions cover the
actual no-Secure/additional-`wr_pf` shape, finite expiry and immutable scan time;
unchanged ordinary cookie guards; rejected owner/scope/credential changes;
exclusive/idempotent persistence, concurrent locks, stale evidence, pending-file
cleanup and activation rollback; retained QR/stop/authorization/other feeds;
public/scheduled denial; one initial local validation, subsequent refusal stop,
and ten-body success followed by a manual repeat returning the same article IDs.
Existing protected SQLite save/deduplication tests remain the database acceptance
baseline. All tests use mock HTTP and temporary private files. The integration
owner must separately record live latest-ten bodies, saved/openable images,
protected production writes and repeat deduplication; no fresh renewal is needed
while the cached credential remains valid.
