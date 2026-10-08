# Native publisher candidate validation

This server entry validates a new publisher before a private Provider binding exists. The original authenticated local `feed.addFromArticle` route now consumes it through the native adapter registered in `TrpcModule`. Current implementation and tests are local; the running production package has not been replaced. No external publication or live platform request is part of this change.

## Consumer contract

Import from `apps/server/src/collection/weread-publisher-validation.ts`:

```ts
const original = await resolveWereadPublisherOriginal({
  url: submittedPublicArticleUrl,
  account: selectedDatabaseAccount,
  trigger: 'local-manual',
});
if (original.status !== 'reviewed-original') return pendingOriginal(original);
const verified = await validateWereadPublisherCandidate({
  account: selectedDatabaseAccount,
  publicArticleHtml: original.html,
  trigger: 'local-manual',
});

await withVerifiedWereadCandidateBinding(verified, async (context) => {
  // Consistent backup / SQLite rehearsal precede production changes.
  // Recheck the selected DB account in this transaction.
  // Merge context.binding + context.evidence into the existing private
  // binding schema, retain old source-stop paths and all user data.
  // Commit DB/config with compensation on partial failure.
  // Do not call the old confirmation function: this callback holds locks.
  return commitPublisherBinding(context);
});

// First update: reuses the actual verified offset-zero directory response.
const update = await collection.collectVerifiedWereadCandidate(verified);
// Later original manual refreshes use the confirmed generic Provider normally.
```

`account` is the selected server-side database row `{id,name,status,token}`. `weread-public-original.ts` resolves a fresh submitted URL using the existing official-domain, DNS-pinned public downloader without cookies, redirects or retries. It checks the account and retained stops before the request, bounds HTML to 10MiB, and retains the attempt privately. A short URL is mapped only by its actual successful original-page response; a long URL must match that page's canonical identity. Challenge/refusal responses cannot become identity evidence. The existing safe real-Location policy supplies a five-minute verification link when available; no generic homepage or invented callback is supplied. HTML is server-only and nonenumerable. Private config defaults to `OWNER_SEARCH_CONFIG_FILE`; the optional absolute `configFile` override exists for isolated tests/internal integration and must never be client-controlled. No credential, private path or candidate-state path is accepted from a browser.

`wereadPublisherCandidateFromOriginal(html)` reuses the existing nonexecuting original-page parser and publisher DOM field. It requires page-supplied original URL, matching static biz/mid/idx, original publication time, title and publisher name. It yields a candidate `MP_WXS_…` ID, name, biz, original URL and SHA256. Only an actual nonempty, identity-matching directory response can supply native binding evidence. The candidate input retains `bookIdStatus: candidate`; the separate `status: directory-verified` and `bindingEvidence` record what the real response verified. No directory ordering timestamp becomes an article publication time.

The serializable result contains `candidate`, parsed `directory`, latest-ten candidate `selection`, and `bindingEvidence` (account ID, publisher ID/name, original and directory hashes, verification time/revision, exactly one request, `bodyVerified:false`). It contains no token, Cookie, session object/path, raw HTML or private response text. A serialized/cloned/forged result cannot be consumed: execution context is held only by this module's WeakMap. This prevents a client assertion from authorizing binding/body requests. A process restart does not grant a fresh attempt.

The binding callback alone receives a complete server-only `SearchConfig` with `wereadDirectoryEnabled:true` and `sourcePolicy:'native-directory-only'`, plus evidence and account revision. Existing legitimate lifecycle/source-stop references are retained. A new native-only binding may use an empty `originalStopFiles` array only under this explicit policy; the old search/public-original collection entry rejects it before HTTP. No fabricated upstream refusal or another publisher's identity is needed to satisfy the schema. The adapter publishes an immutable private configuration snapshot, activates the staged Feed, and compensates the pointer and unchanged inactive row on failure.

The callback holds the private config native-login lock, candidate state lock and selected account's known native state locks. Do not acquire them again via `confirmManualWereadBinding`, or overwrite the module-owned candidate state file. Read the fresh database account and compare its normal-session/account revision through the shared `resolveNativeWereadAccount` before committing. Consumers own consistent backup, DB transaction, private config pointer publication and compensation if any part fails. A failed callback returns `BINDING_FAILED`, leaves directory evidence unchanged, never authorizes continuation and never resends HTTP. The same in-process evidence permits a local transaction retry. No fallible state/audit publication is added after a successful callback commit.

`continueVerifiedWereadCandidate(verified)` is the lower-level alternative returning the existing `ProviderPage`; it must not be called in addition to `collectVerifiedWereadCandidate`. It requires successful binding, reserves continuation durably once, reuses the first-page response and its same-owner cookie lifecycle, and shares the existing body/image pipeline. At most one next page uses the actual raw group count (not synckey), then ten selected original bodies. It never fills a missing ten with older articles. Images pass the existing URL/byte checks and inline archiver. The service entry checks the saved publisher/channel, invokes the original consistent-backup gate and identity-preserving SQLite transaction, and retains legacy IDs, original trusted times, content, metrics and other publishers. Saver failure does not permit replaying the network operation.

## Session and stop rules

Normal-account resolution is independent of `readOwnerSearchConfig(mpId)`, removing the prebinding circle. It reuses the same immutable native-session index/hash, normal-login source, enabled account, exact wr_vid/wr_skey association, cookie scope and expiry checks as the existing binding. It neither converts arbitrary account tokens into browser credentials nor renews an expired first-time candidate session.

Existing selected-account native states are locked and checked with `ownerLatestStopMessage`. Active or unverified historical stops block discovery before a request. Only existing explicitly authorized successful maintenance is recognized; this module grants none. Candidate refusal is retained and blocks both repeating that candidate and using a different publisher as a way around the selected account's failure. Switching accounts cannot replay that consumed publisher attempt. No stop clearing, account fallback, retries, endpoint guessing, signature generation, verification bypass, browser extension or pairing is implemented.

The deterministic private `candidate-directory-<publisher-hash>.json` reserves one attempt before HTTP. Exclusive locks/reservation and immutable response files fail closed on interruption or filesystem failure. No automatic timeout reset removes those records. The copied normal session is rechecked before binding and continuation; changed/expired credentials reject without body requests. All shared GETs use the same fixed official endpoints, existing cookie lifecycle, 20-second timeout, 8MiB response limit and `maxRedirects:0`/`proxy:false`. Response recording precedes parsing; arbitrary upstream messages do not reach public errors or stop text.

## Error contract and limits

`WereadCandidateValidationError.code` is stable. Expected consumer states include `PUBLIC_IDENTITY_INVALID`, `ACCOUNT_NOT_READY`, `RETAINED_STOP`, `ATTEMPT_CONSUMED`, `IN_PROGRESS`, `STATE_CHANGED`, `STATE_IO_FAILED`, `UPSTREAM_HTTP`, `UPSTREAM_BUSINESS`, `DIRECTORY_INVALID`, `EMPTY_DIRECTORY`, `INVALID_EVIDENCE`, `BINDING_FAILED`, `BINDING_REQUIRED`, `REQUEST_FAILED` and `COLLECTION_FAILED`. Nonmanual execution is `MANUAL_ONLY`. HTTP refusals also expose only numeric `httpStatus`; business refusals expose the original numeric `businessCode` (for example -2041), never errMsg/errLog. No refusal permits another request.

A successful nonempty directory proves publisher-level native directory identity for this account/attempt, not ten complete bodies, future access or full history. `collectVerifiedWereadCandidate` reports the existing recent-window result only after protected persistence. Offline fixtures, real isolated SQLite rollback and synthetic PNG bytes verify code contracts; they are not live source or fresh-publication acceptance. The remaining acceptance is one real publisher addition and one multi-article update through the authenticated local product entry, under its explicit bounded authorization.
