# Managed manual XHS mode

The fixed same-schema updater accepts an optional, separately reviewed `runtimeMode`:

```json
{
  "kind": "manual-xhs-v1",
  "channelArchives": {
    "wechat": "<SHA-256 of archived references>",
    "xiaohongshu": "<SHA-256 of archived references>"
  }
}
```

Use `managed-runtime-mode.digest(state.archived)` for each real channel. Include this exact object in both the profile and the independent `expected.runtimeMode` passed to `freezeFixedProfile` and `prepareFixedDispatch`. Freeze the complete current control closure from the reviewed source commit. Existing profiles continue to launch held. Never edit a frozen profile, adopt candidate hashes as old trust, or replay old installation plans.

For an already running, completed managed installation, additionally review `previousCompletion` with exactly four `{path, sha256}` pins: `journal`, `control`, `registry` and `permit`, at the existing journal and its `.control`, `.native-processes` and `.permit` siblings. Supply the identical object as `expected.previousCompletion` to both freezer and dispatch. Do not reuse the old frozen plan. This path requires a fresh, exact live current-role identity, a completed matching transaction/permit, the original task definition and all existing writer observations. Incomplete or unknown transactions remain blocked. A recovered transaction is eligible only with its completed restore proof, reused backup and matching permit for the live prior role. Cold-empty profiles cannot claim this live completion.

Under the original installation locks, the driver preserves those exact four old documents in `.wewe-update.json.completed-<prior-transaction>.json` with their hashes before the original updater starts a new transaction. It never fabricates a stop receipt or deletes prior evidence. A repeat after success verifies that retained archive and the current commit/permit, then returns read-only `already-current`; missing or altered evidence fails closed.

Before maintenance effects, both channel states must be paused and match the reviewed, nonempty archived-reference digests and backup receipts. All existing process, backup, schema, capacity and install checks still apply. The new candidate is launched with XHS live access enabled and global recovery hold disabled, while all timers, Wechat active/cache/media work, desktop scheduling, comments and periodic retention remain disabled. Both channels remain paused; the mode creates no task and makes no source request. Candidate health must prove the actual mode/flags against the same native transaction, version and database.

After the original install commit, the updater persists the mode in its existing journal before granting the matching permit. The immutable runtime and normal launcher read only a completed journal and matching role/transaction permit on subsequent starts. A changed archive, foreign commit or resumed Wechat channel fails closed. A later formal XHS channel resume may change its revision while preserving its archive. Wechat resume and source execution stay blocked in this XHS-only mode. Authentication and scheduled policy/session/exclusion/budget admission remain mandatory; the mode grants no source permission. Installation failure recovers the old role under full hold.

For acceptance, keep Wechat paused and exclude the complete account containing unknown profile/list requests. Use one explicit subscribed author with a fresh batch UUID through the existing list-only batch route and scheduled review. A cold task may request author context, then multiple list pages until the existing end/cursor/budget conditions stop it. This route is not strictly one page. The regression covers one author, one profile request and two list pages with a duplicate note, saving it once, with no detail/media/comment requests and unchanged historical unknown records. Do not advance old batches or retry unknown targets.

Validation includes local original-native temporary-SQLite installation/recovery tests, ordinary host policy tests, real isolated Prisma history/queue protection and list scope tests, and the existing CI checks. The native fixture requires explicitly supplied original reviewed native/lock/Python materials and a trusted control commit; it is not a production authority. Do not publish local bindings, credentials, database/backup contents or raw audit evidence. CI success and managed startup do not establish successful real subscription collection.

## Restore the two existing collection schedules

Use the separately approved `scheduled-dual-v1` mode with the same archive digest, completed-install handoff and owner-review contract. Both channels must be paused throughout installation. After commit, the application keeps each channel paused until the authenticated channel resume action independently succeeds with the current backup proof.

The original 09:15, 14:00 and 17:30 Asia/Shanghai slots continue. The latest channel administration receipt prevents submission of older slots, including a retained pending slot from before pause. Existing task and request protections continue to apply. Scheduled XHS omits an author with unresolved profile or list history while allowing the other approved authors to proceed. The existing per-note exclusions still apply. The XHS clock starts independently of WeChat configuration. Scheduled WeChat requires its own admitted provider and feed binding. The legacy WeChat timer and daily catch-up remain disabled in this mode. The original durable source gate remains in effect. An unresolved `pending` source outcome requires evidence or the provider's supported reconciliation and stays closed.

A reserved list-only batch can settle locally when its exact terminal task and reviewed profile/list response receipts prove an outcome with historical omissions. The batch records `partial` and the omission count, retaining the task and original fence evidence. Missing, conflicting, non-list or unknown responses still prevent settlement. This branch sends no new request.

## Sync WeChat while its source request is unresolved

The reviewed `scheduled-dual-v1` profile can opt into `"wechatLocalCache": true`. The original installer verifies the project's existing `.wechat2rss-data/res.db`, retains the WeChat source pause and enables the read-only SQLite watcher. The health response reports the local cache flag separately from the active WeChat schedule. XHS keeps its existing clock and independent channel control. If the vendor database later becomes unavailable, the cache worker reports the error and the XHS clock continues.

Use the existing per-subscription update or **同步全部缓存** to reconcile the vendor's locally stored articles. The automatic watcher uses the same protected incremental saver. Each feed must match its existing publisher identity. Writes retain the article identity and publication-time checks, preserve existing edits and leave incomplete media pending. Source submissions, account requests and media downloads stay closed within this mode. A feed error leaves its previous content intact while other eligible feeds can sync. No old task or unknown claim is replayed or settled.

The vendor continues to populate its own database on its existing schedule. A local cache sync does not force the vendor to fetch a new article. Forced WeChat refresh remains closed until the unresolved source request can be reconciled with trustworthy evidence.

# Managed WeChat active checks

With both `wechatLocalCache: true` and `wechatActiveRefresh: true` in the reviewed scheduled mode, the feed page offers a separate active check for one existing Wechat2RSS subscription. The ordinary cache buttons and background cache watcher keep their local-only behavior. The application reports when the vendor has accepted a check. Articles are saved later through the existing cache identity and merge path.

Both channels begin the activation paused. Resume WeChat through Channel Tasks after confirming the committed release, protected backup, and archived history. Its scheduler uses the existing Shanghai slots of 09:15, 14:00 and 17:30. It rotates eligible subscriptions by their last attempt and admits at most one vendor operation in each slot during rollout. The pause applies to both manual and scheduled active checks. The local cache watcher and the XHS clock are independent.

Existing unresolved claims stay bound to their original subscriptions. A new uncertain result is also retained for that subscription. A new request requires at least six hours since the target's last vendor check and last local submission, at least 45 minutes before its native vendor check, and at least 30 seconds between active operations. WeChat account restrictions and HTTP 401, 403 or 429 stop active checks for this WeChat source. The previous shared gate row is preserved, including an existing recorded restriction. Legacy WeChat batch and source routes remain behind their original gate.
