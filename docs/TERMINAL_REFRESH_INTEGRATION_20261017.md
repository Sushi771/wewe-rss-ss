# Terminal refresh integration on the deployed backend baseline

## Scope

The integration baseline is `12d04edebedf6eed3be07466f9cbf3b899a437a8`.
PR47 ends at `6aa511cec97f039e03bb2dab29db7a88c013c856`, with common
ancestor `45a3942a8cc56b29e53f66e11aef4acd2f6d101e`. Integrate the complete
five-commit range, not only the final three-file review correction:

1. `58f036d`: release ended work from later-round admission.
2. `1891908`: retain confirmed queued receipts as cache recovery.
3. `5f06f54`: audit every input and retire known-unsent cache-only tails.
4. `d2b5d45`: bind completion coverage to each source's claim.
5. `6aa511c`: retain legacy unknowns and reject contradictory claim chronology.

All eleven PR47 files merge without conflicts on the deployed baseline. This
preserves the baseline's export-media reporting, article-history safeguards,
backup coordination, and browser lifecycle fixes. No package manifest, lockfile,
database schema, migration, or release-generation implementation changes.

See [terminal admission and coverage](REFRESH_TERMINAL_ADMISSION.md) for the
state predicates and their regression cases. Known-unsent closed or expired
work can stop occupying a later intent. Unknown submissions, actual in-flight
owners, explicit stops, account/instance gates, and original retry budgets remain
authoritative. An old accepted receipt is never permission to submit it again.
The progress UI distinguishes completed work, pending work, lawful exclusions,
and anomalies; a smaller successful subset cannot be described as a fully
updated round.

## Validation and development environment

Use the existing full development dependencies. The private compact-build
dependency graph contains runtime/build inputs but is not a complete test and
lint installation. Missing Jest/ESLint or generated-client types in that graph
are environment failures, not passing tests or evidence of an application
regression. Reuse existing development junctions without installing or copying
dependencies. Keep the initial environment-failure records in private evidence.

Run native subscription tests from `apps/server` or the repository root, as
documented in PR47. The integration validation covers the complete server Jest
suite, server/web types and lint, progress UI regressions, and backup-policy AST
and registered-boundary checks. Test databases and durable queue records are
synthetic. Do not invoke endpoint/platform scripts, a real scheduler intent,
production queue normalization, or production database copies during validation.

Exact local results and remote workflow links belong in the integration PR.
Remote checks must be associated with the final exact integration commit.

## What the previous deployment logs establish

The previously approved deployment of the baseline first failed the unchanged
180-second composite HTTP readiness check and recovered its prior version. That
attempt discarded service stdout/stderr and did not retain per-request results.
It therefore does not establish whether a page request, an RSS request, or some
other transient condition caused the timeout. Do not label network instability,
cold database reads, port competition, or a business-code change as the root
cause without evidence.

A later separately approved attempt reused the same installed baseline package
and unchanged readiness predicate. Its successful complete-response timings
were 106 ms for startup status, 32 ms for the dashboard, and 2,202 ms for a
20-item summary RSS response. RSS stayed within the original 2,500 ms request
timeout; this does not prove what happened in the earlier attempt. Confirmed
old-service stop to pointer publication was 14,470 ms. This measures controller
milestones, not the availability of every concurrent user request.

The later attempt retained bounded private process output, per-request timings,
HTTP status and body-byte counts, parsed readiness/item counts, and exact port
identity observations. Credentials, response bodies, local audit artifacts and
private article data must not be committed or attached to a PR. Two offline
synthetic runs, including the original predicate on generated article volume
and a large generated body, passed; they cannot establish production equivalence.

## Deployment boundary

This integration is not part of the already deployed baseline. Publishing a PR
does not authorize deployment, release-package generation, rewriting production
queue records, replaying old intents, or manually running a missed schedule.
After review and separate release approval, verify the next natural scheduler
intent against every original input. Preserve unknown outcomes and old receipts;
do not manually replay terminal batches to manufacture a successful round.
