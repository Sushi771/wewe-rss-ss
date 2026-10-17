# Receipt recovery and periodic retention release candidate

This candidate combines two independently reviewed versions on the current
production source baseline. It prepares a release for separate review; it does not
merge a GitHub PR, deploy, change running configuration or authorize deletion.

| Source                    | Exact reviewed SHA                         |
| ------------------------- | ------------------------------------------ |
| Production / PR48         | `24ac842b84d9db7fa507a971b84ea63a1ed98249` |
| Periodic retention / PR49 | `446865080d5fd322329b99b714c99b0818ff1a49` |
| Response receipts / PR50  | `c5db7b1e81f13f3aeff55cf962e46e111013cef3` |

The base integration `af25b5ec10fc832e0a763f31915f502ae58fd6dd` retained both
reviewed histories and all 23 reviewed file blobs. Its follow-up adds the explicit
[unknown future-occupancy control](UNKNOWN_REFRESH_OCCUPANCY_RELEASE.md), after
the historical unknown gate was found to hold later rounds indefinitely. Both
reviewed source HEADs remain ancestors. The final candidate SHA and its own CI
results are recorded in the draft integration PR; the base integration's earlier
green checks do not verify this follow-up.

## Automatic cleanup stays disabled

`SQLITE_PERIODIC_RETENTION_ENABLED` must remain unset or `0`. Only an explicit `1`
activates the reviewed opt-in retention path. Including that code in a release is
not activation approval. Existing periodic snapshot configuration is unchanged.

Any later activation requires a separate decision about the exact physical roots,
eligible deletion scope, protected references and recovery windows, copy/byte/read
limits and staging reserve. The candidate's proposed defaults do not authorize
historical cleanup, permanent deletion or expanding the selected scope. Unknown,
unique and protected state remains retained; a storage or ownership hold must not
be bypassed to meet a count or byte target.

See [the retention policy](AUTOMATIC_PERIODIC_RETENTION.md) for the reviewed native
handle, generated-column, protection and failure boundaries.

## Historical unknown requests do not become successful automatically

An old unknown request without a matching durable validated-response proof remains
unknown. This candidate cannot reconstruct its missing response or exception.
HTTP200 access logs, check/scheduling timestamps and cache activity do not establish
acceptance, and the recovery path never resends an unknown request.

An independently authorized, evidence-bound disposition may release that item's
occupancy for a different future intent after an explicit boundary. It preserves
the original unknown SQL/item ledger and history coverage anomaly, seals old
execution, and does not enqueue, wake or make a request. Without matching approval,
evidence and source/instance binding, it remains held. This is separate from
accepted-response recovery; actual disposition and rollout require separate action.

For a request with a valid matching proof, the existing worker may recover the same
SQL claim through strict incremental admission and a conditional transaction.
Acceptance establishes the request outcome only; it does not prove new articles,
fresh upstream cache generation or complete bodies/images. Independent cache
synchronization remains separate. Missing, invalid, replaced or unpublished proof
fails closed; process-crash tests do not establish host power-loss durability.

See [the response receipt contract](REFRESH_RESPONSE_RECONCILIATION.md) for proof
binding, safe diagnostics and the unavoidable gap before publication.

## Integration verification and release boundary

Verification uses owned small synthetic databases, mocked transport and existing
development dependencies. It checks the complete server regression, real process
receipt crash boundaries, periodic-owner and retention protections, ordinary-write
backup boundaries, types, lint, formatting and build. A simulated cleanup in an
owned test fixture is not production cleanup or activation.

Before any later deployment, select the frozen integration SHA and verify that
automatic retention remains disabled in the actual deployment configuration.
Production access, service control, rollout, real platform requests and any
subsequent cleanup activation remain outside this integration task.
