# Gated image transient outcomes

A received HTTP 408 or 5xx image response remains a transient availability failure even when an archive caller supplies the durable Wechat2RSS source gate. The caller releases only its own pending request token after response cancellation settles. This uses the gate's existing ordinary-outcome completion path; it does not treat the image as downloaded or valid.

HTTP 401, 403 and 429 still persist a source stop. Unknown transport failures, interrupted body reads, unresolved cancellation, existing pending/stopped states, changed ownership, failed verification and failed completion writes remain fail-closed. There is no reset or recovery of historical pending requests in this change.

The normal automatic media queue currently calls image fetching without this source gate. This correction therefore does not establish the cause of a stalled automatic queue. Queue tests separately verify the existing four-attempt limit and 1-minute, 5-minute and 30-minute retry delays using synthetic HTTP responses, while existing global-bound tests remain enabled.

Regression coverage uses mocked HTTP and fresh temporary SQLite databases through the real Prisma client and source gate. It exercises transient and restriction responses, cancellation rejection, restart persistence, unknown failures, token ownership, completion failures, and a later article being archived after an earlier transient image failure. No test requires a real source request or an application database.

Run the focused checks with:

- `pnpm --filter server exec jest --runInBand src/collection/image-fetch-gate.spec.ts src/collection/image-fetch.spec.ts src/collection/archive-provider-images.spec.ts src/feeds/automatic-media-queue.spec.ts`
- `pnpm --filter server exec tsc --noEmit --incremental false`
- `pnpm --filter server exec eslint src/collection/image-fetch.ts src/collection/image-fetch-gate.spec.ts src/feeds/automatic-media-queue.spec.ts`

These are offline engineering checks, not evidence of installation, production recovery or real-source acceptance. Full CI results must be evaluated for the exact published commit.

Local validation for this change passed: 9 focused and adjacent Jest suites (165 tests), the offline media recovery harness (22 tests), server type checking and build, focused ESLint and formatting, and the backup-boundary policy check. The full repository test matrix is delegated to exact-commit CI; local focused results do not replace it.
