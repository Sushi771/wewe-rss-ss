# Refresh completion and remaining media limits

Each wave submits at most five eligible sources; all sources in a partial final
wave are included. Account checks, backups and reservations remain serial.
Already accepted requests and unknown receipts are retained without replay.
Restrictions pause further submissions; user stops remain authoritative across
queued persistence, recovery and late receipts.

| Status         | What it establishes                                                             |
| -------------- | ------------------------------------------------------------------------------- |
| Accepted       | The upstream accepted the update request; cache readiness still needs checking. |
| List ready     | The confirmed list for the refresh scope is synchronized.                       |
| Text ready     | The required cached bodies for that scope are available.                        |
| Media ready    | Media in that verified cache scope passes completeness checks.                  |
| Saved/exported | The separate local export operation completed and its media result was checked. |

A successful refresh can therefore retain `mediaReady: false`. Preserve readable
bodies and valid images, show pending media separately, and do not overwrite
handwritten notes merely to make a completeness indicator green. Local media
pending counts refer to affected articles; upstream blocked-image counts describe
separate media evidence and must not be added as another article count.

## Relationship to PR28

[PR28](https://github.com/Sushi771/wewe-rss-ss/pull/28), at
`39d39baf3ad9356b4ea4f03f63dd4bad57030f87`, is absent from the shipped runtime
`d8c35aa9ca2e1d74bedd1ab30cbd0acea4ec5434`.
It addresses image elements with missing sources, including sources removed by
sanitization. Single and batch exports report those results as incomplete while
preserving useful bodies and valid images. It also checks current cached evidence
before trusting a legacy receipt that incorrectly claimed complete media; repeated
saves report incompleteness without rewriting existing notes, images or receipts.

This is an export correctness and note-preservation fix. It does not obtain a lost
image source, fetch missing media, unblock an upstream image, or change refresh
wave scheduling. Undeployed PR28 can explain inaccurate export completeness for
its specific cases; it does not establish the cause of every pending cache image.
Deploying it requires its own current-base integration, review and authorization.

## Minimum evidence for a subsequent media fix

Use one existing representative cached article for each relevant category: lost
source after sanitization, known source with missing or invalid local media, and
upstream-blocked media. Retain article identity and media evidence privately.
Record the source-present/source-missing category, validation result, existing
error category/status, cached body state and receipt version. Inspect existing
evidence before proposing a fresh request; missing source alone cannot authorize
a guessed URL or replay. Determine whether the correction belongs to the cache
scanner, media retrieval, export formatter or legacy receipt reuse.

Reproduce the selected case in an isolated fixture and verify that readable bodies,
valid image bytes and handwritten notes remain intact. Do not broaden a source-less
export correction into an unapproved full-library refetch. Public documentation and
PR descriptions contain generic behavior and offline evidence, not private source
lists, local paths, runtime audit records or credentials.
