# Receipt recovery and periodic retention release candidate

This candidate combines two independently reviewed versions on the current
production source baseline. It prepares a release for separate review; it does not
merge a GitHub PR, deploy, change running configuration or authorize deletion.

| Source                    | Exact reviewed SHA                         |
| ------------------------- | ------------------------------------------ |
| Production / PR48         | `24ac842b84d9db7fa507a971b84ea63a1ed98249` |
| Periodic retention / PR49 | `446865080d5fd322329b99b714c99b0818ff1a49` |
| Response receipts / PR50  | `c5db7b1e81f13f3aeff55cf962e46e111013cef3` |

The integration retains both reviewed histories. Their runtime and test files are
preserved byte for byte; the shared CI workflow retains both changes. This release
note is the only new integration document. The final candidate SHA and its own CI
results are recorded in the draft integration PR, independently of either source
PR's earlier green checks.

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
