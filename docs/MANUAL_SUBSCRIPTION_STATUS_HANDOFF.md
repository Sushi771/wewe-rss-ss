# Manual subscription status handoff (2026-10-04)

## Integration follow-up

The integration owner used the existing authorized local application authentication and the saved target binding to execute the original refresh exactly once at 2026-10-04T17:53:06Z. The first directory response was HTTP200 with business code -2012 (70 bytes). The provider persisted a new stop after one request; no body/image request or account rotation followed. Account/article fields and other subscriptions stayed unchanged; only the target's authorized receipt fields changed. These are current results, distinct from the historical cover401 below. The integrated deployment retains this stop and all user login/binding changes. No rescan or automatic retry is prescribed. See [integrated status](MANUAL_REFRESH_DOWNLOAD_INTEGRATION.md).

This change makes the existing account connection preview show every saved
subscription, including unavailable choices. It separates a saved connection
from a later refresh receipt. It does not issue collection requests or configure
additional subscriptions.

## Backend contract for the account UI

`account.manualRefreshOptions` keeps the existing `mpId/name/revision/ready/message`
fields and adds:

| Field             | Meaning                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `configured`      | A private source binding exists for this subscription.                                                                                                  |
| `reason`          | `source-unconfigured`, `different-channel`, `session-unavailable`, or `null` for an available preview.                                                  |
| `connected`       | The selected persisted normal login is explicitly bound to this target, with directory mode enabled and its current stop/authorization check satisfied. |
| `connectedAt`     | Time of that explicit local connection, or `null`.                                                                                                      |
| `refreshRequired` | A valid connection exists, but no later receipt from the original WeRead refresh provider has been recorded.                                            |

All saved subscriptions are returned in their saved order. Unconfigured sources
and other channels remain disabled. The existing UI already renders the message
and disables `ready=false` choices. It may use `connected` to label an existing
connection and `refreshRequired` to link to `/dash/feeds/<mpId>`; it must not
automatically invoke a refresh when reading a preview. No nickname or target
name is hardcoded by this selection logic.

A receipt is evidence of backend collection handling, including a refusal; it
is not proof of successful body/image collection. An older receipt, malformed
JSON, or a different provider does not establish a refresh after connection.
Legacy receipts have whole-second timestamps; a receipt in the fractional
second containing the connection is conservatively treated as unproven.
The article count or `created=0` is not used to infer failure. A latest-ten
refresh can legitimately add zero rows when those articles already exist or
the publisher has not published anything new. Future new-article discovery
requires a naturally published article; do not fabricate an extra article.

## Read-only live finding

The user's target connection was saved at 2026-10-04T17:12:06.301Z. At
17:22:20Z, SQLite had 2 accounts, 12 subscriptions and 1450 articles,
`quick_check=ok`. The normal Web session and the saved authorization matched;
the exact target, stop hash, login time and distinct prior authentication were
valid. Directory mode was enabled. The active state still contained only the
September 30 cover HTTP 401 response and stop; its old October 3 database
receipt is not a result of the user's October 4 click.

The account confirmation mutation only saves authorization. The separate
subscription-page button `更新本号` invokes `feed.refreshArticles({mpId})`,
which reaches the existing latest-ten directory/body/image and protected SQLite
save path. No evidence currently establishes that this second mutation was
received after connection; this finding does not assign fault to the user.

This worker's source environment files do not supply a usable application
access code for the active private service. Its local preflight could not
authenticate and made no refresh mutation or Tencent request. The sole
integration/deployment thread should use its already authorized application
context to execute the target's single original refresh, retain the new result,
and stop immediately on challenge/refusal. Do not obtain browser secrets or
guess credentials, clear stops, rotate accounts after a challenge, or rerun
the consumed single-article experiment. This finding does not require a new
Tencent QR login or own-profile request.

## Reuse and remaining acceptance

The existing directory parser, body identity check, image archiver, protected
save and exporter are reused unchanged. Focused GitHub source inspection found:

- [earss_source_weread mp.ex at c98ac76](https://github.com/ll1zt/earss_source_weread/blob/c98ac76bc74eba5047b5084f84c263185dfa3aa1/lib/earss_source_weread/mp.ex)
  uses the same directory/content endpoints; its own historical/current list
  descriptions differ, and it is not live acceptance for this account.
- [weread.koplugin verification script at 9caeb0f](https://github.com/finlater/weread.koplugin/blob/9caeb0f15fb9ca2b03f0f512d93261f6cb75619d/scripts/verify_mp_articles.py)
  discusses list access challenges and copied browser tickets. That ticket
  strategy is not used by this change.

Neither replaces the project's existing implementation or proves that a plain
backend directory request will succeed for the selected login. Previously
saved official evidence remains 40 directory articles and one complete body
with a saved image; it must not be labelled a real latest-ten refresh.

The integration owner retains all deployment work and port 4000. Required live
acceptance remains: original refresh receipt, current ten distinct bodies and
actual saved/openable images, repeat refresh with no duplicate rows and no
loss/empty overwrite of old data. Scheduled refresh stays disabled. Additional
subscriptions still need explicit private source configuration and channel
selection before they can be connected; this preview does not make them usable.

## Validation

Focused offline suites cover all twelve choices, unchanged configuration while
previewing, explicit connection, older/malformed/different-provider receipts,
refusal receipts, and successful ten-article receipts with zero created rows.
They also exercise retained historical stops, cooldowns, the latest-ten
body/image pipeline and channel routing. No real HTTP is used in these suites.

Local verification: all 40 server suites / 575 tests passed; server build,
frontend TypeScript check, changed-source ESLint and Prettier passed. The final
receipt-ordering adjustment also passed 3 focused suites / 60 tests. GitHub
CI must be checked against the final branch SHA after opening the draft PR;
the workflow only triggers PRs targeting `main`, so the draft targets `main`
and states that the integration owner should cherry-pick this worker's commit.
