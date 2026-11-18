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

For an already running, completed managed installation, additionally review `previousCompletion` with exactly four `{path, sha256}` pins: `journal`, `control`, `registry` and `permit`, at the existing journal and its `.control`, `.native-processes` and `.permit` siblings. Supply the identical object as `expected.previousCompletion` to both freezer and dispatch. Do not reuse the old frozen plan. This path requires a fresh, exact live current-role identity, a completed matching transaction/permit, the original task definition and all existing writer observations. Incomplete, recovered or unknown transactions remain blocked. Cold-empty profiles cannot claim this live completion.

Under the original installation locks, the driver preserves those exact four old documents in `.wewe-update.json.completed-<prior-transaction>.json` with their hashes before the original updater starts a new transaction. It never fabricates a stop receipt or deletes prior evidence. A repeat after success verifies that retained archive and the current commit/permit, then returns read-only `already-current`; missing or altered evidence fails closed.

Before maintenance effects, both channel states must be paused and match the reviewed, nonempty archived-reference digests and backup receipts. All existing process, backup, schema, capacity and install checks still apply. The new candidate is launched with XHS live access enabled and global recovery hold disabled, while all timers, Wechat active/cache/media work, desktop scheduling, comments and periodic retention remain disabled. Both channels remain paused; the mode creates no task and makes no source request. Candidate health must prove the actual mode/flags against the same native transaction, version and database.

After the original install commit, the updater persists the mode in its existing journal before granting the matching permit. The immutable runtime and normal launcher read only a completed journal and matching role/transaction permit on subsequent starts. A changed archive, foreign commit or resumed Wechat channel fails closed. A later formal XHS channel resume may change its revision while preserving its archive. Wechat resume and source execution stay blocked in this XHS-only mode. Authentication and scheduled policy/session/exclusion/budget admission remain mandatory; the mode grants no source permission. Installation failure recovers the old role under full hold.

For acceptance, keep Wechat paused and exclude the complete account containing unknown profile/list requests. Use one explicit subscribed author with a fresh batch UUID through the existing list-only batch route and scheduled review. A cold task may request author context, then multiple list pages until the existing end/cursor/budget conditions stop it. This route is not strictly one page. The regression covers one author, one profile request and two list pages with a duplicate note, saving it once, with no detail/media/comment requests and unchanged historical unknown records. Do not advance old batches or retry unknown targets.

Validation includes local original-native temporary-SQLite installation/recovery tests, ordinary host policy tests, real isolated Prisma history/queue protection and list scope tests, and the existing CI checks. The native fixture requires explicitly supplied original reviewed native/lock/Python materials and a trusted control commit; it is not a production authority. Do not publish local bindings, credentials, database/backup contents or raw audit evidence. CI success and managed startup do not establish successful real subscription collection.
