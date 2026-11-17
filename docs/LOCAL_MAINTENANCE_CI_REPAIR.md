# Local maintenance contract regression

The recovery candidate must pass both its maintenance-specific checks and the
existing installation, build and observation contracts. A local test pass does
not authorize installation or collection.

The direct-copy installation introduced in `7b1d8c4` omitted the original
three-role budget, exclusive ownership, exact proof validation, reuse and owned
failure cleanup. Restore the previously reviewed implementation rather than
weakening those regression tests. Installation uses `--plan` with the reviewed
private plan; it does not activate a release or remove historical packages.

The build entry must retain its writable-session check, source/runtime-bound
reuse lookup, finite scope and build reservation. A read-only observation cannot
enter it, and an already verified candidate is reused without estimating or
creating another generation. The explicit local Prisma schema-engine override
remains available for offline builds.

The exhaustive host-effect catalog now identifies each new maintenance module.
Native control modules retain their exact code pins and opaque scope/lease
checks. Temporary native fixtures are classified separately and cannot be
imported by production host modules. No source route is added to health checks.

Run the existing finite-lifecycle and host-effect checks, followed by the held
management, exact-binding and installed-adapter checks. CI also runs format,
lint, type, server and existing Windows checks without excluding safety tests.

The Windows native maintenance fixture additionally requires explicitly reviewed
local inputs: `WEWE_FORMAL_NATIVE_SOURCE`, `WEWE_FORMAL_LOCK_SOURCE`,
`WEWE_TEST_PYTHON` and `WEWE_TEST_CONTROL_COMMIT`. The last value is the full Git
commit independently reviewed by the test owner for the four control sources;
the fixture verifies their bytes against those Git objects. New control bytes
require a new freeze. Fixture receipts never grant authority to a real host.

Build the final candidate from the exact CI-verified commit. Retain a local
receipt mapping every source input and packaged control file to that commit and
verify the complete immutable release before handing it to the sole installer.
