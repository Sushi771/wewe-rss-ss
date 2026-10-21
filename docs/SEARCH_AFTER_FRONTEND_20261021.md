# Search after the installed frontend repair

The integration retains frontend source `f618e48f48ff0e3df1c646cb8a666a2461815732`
and merges PR82 `7bbdeef40019708c17f2f2aaed631ee78926d9a7` plus PR83
`8b880983058a0af19baee49cd8ef89d9e161bf1d`. Only the list receives the reviewed
body-search controls. The export dialog, reader and human-facing error messages
remain the installed repair. Runtime checks, native identity checks and previous
frontend delivery code are retained; the frontend-only update entry must never
be used to install this database-changing search feature.

The rollback recipe additionally accepts the exact installed frontend repair
source above. Its backend is unchanged from `48fdf73f`; both inspectors still pin
the same twenty base migrations and the sole optional search migration21.
Arbitrary source identifiers, marker fields and schema drift remain rejected.
Use the repaired source for a future rollback package so rollback preserves the
new UI wording. An existing immutable package is never edited in place.

The new synthetic preservation regression seeds every one of the nine existing
business tables, including an unknown submission claim, original HTML/media,
metrics and video bytes. It hashes all business rows before migration21, after
migration and after local text extraction. Equal digests and the unchanged
unknown claim are required. Existing search and submission/rollback tests are
also run; these tests are not evidence that packaged application startup works.

Still required before production: build and verify the actual candidate and
compatible repaired-UI rollback packages, rehearse the real runtime/HTTP startup
on synthetic schema20 then21 with migration receipts and task recovery, and
inject candidate failure to prove application rollback without database restore.
Bind the exact package pair and independently review the production migration
and transition plan before executing it. Retain the old database path and data;
do not copy production data to a development checkout or upload article bodies.

The current PR83 build-only implementation still opens the normal release-scope
policy and its full native reference collector. The frontend retain-only plan
does not authorize it. No applicable policy or complete package-pair evidence is
claimed by this integration, and no production migration/restart is performed.
No new build architecture or relaxed reference proof has been added here.
