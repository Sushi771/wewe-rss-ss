import { randomUUID } from 'node:crypto';
import type { RoundTx, RoundRequest } from './xhs-unbound-round';
import { reviewedUnboundMarkers } from './xhs-unbound-round';

/** Executed inside the existing incremental-write transaction. */
export async function reserveRoundBudgetRisk(
  tx: RoundTx,
  reviewId: string,
  request: RoundRequest,
  now: number,
) {
  const retained = await reviewedUnboundMarkers(tx, reviewId);
  const pending = await tx.$queryRawUnsafe<any[]>(
    "SELECT id FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:%'",
  );
  if (pending.some((r) => !retained.includes(r.id)))
    throw Error('XHS_REQUEST_RATE_PAUSED');
  const risk = await tx.$queryRawUnsafe<any[]>(
    "SELECT * FROM xhs_source_risk WHERE id='source'",
  );
  if (risk.length !== 1 || risk[0].state !== 'clear')
    throw Error('XHS_SOURCE_RISK_REVIEW_REQUIRED');
  await reserveRoundBudgets(tx, request, now);
  const owner = randomUUID();
  if (
    (await tx.$executeRawUnsafe(
      "UPDATE xhs_source_risk SET state='pending',owner=?,updated_at=? WHERE id='source' AND state='clear'",
      owner,
      BigInt(now),
    )) !== 1
  )
    throw Error('XHS_SOURCE_RISK_UNAVAILABLE');
  return owner;
}

/** Uses existing limits only; caller must prove its own exact risk admission. */
export async function reserveRoundBudgets(
  tx: RoundTx,
  request: RoundRequest,
  now: number,
) {
  const ids = ['xhs:source-total', 'xhs:original-link:' + request.creatorId];
  for (const id of ids) {
    const found = await tx.$queryRawUnsafe<any[]>(
      'SELECT * FROM xhs_request_budgets WHERE id=?',
      id,
    );
    if (!found.length) {
      if (id === ids[0]) throw Error('XHS_REQUEST_BUDGET_REQUIRED');
      continue;
    }
    const b = found[0];
    if (Number(b.used) >= Number(b.request_limit))
      throw Error('XHS_REQUEST_BUDGET_EXHAUSTED');
    if (Number(b.next_at) > now) throw Error('XHS_REQUEST_RATE_PAUSED');
    if (
      !Number.isSafeInteger(Number(b.interval_ms)) ||
      Number(b.interval_ms) < 1000
    )
      throw Error('XHS_REQUEST_POLICY_INVALID');
    if (
      (await tx.$executeRawUnsafe(
        'UPDATE xhs_request_budgets SET used=used+1,next_at=? WHERE id=? AND used=? AND next_at=?',
        BigInt(now + Number(b.interval_ms)),
        id,
        b.used,
        b.next_at,
      )) !== 1
    )
      throw Error('XHS_REQUEST_BUDGET_UNAVAILABLE');
  }
}

/** Unknown keeps source pending. Only proven response completion can clear owner. */
export async function finishRoundRisk(
  tx: RoundTx,
  owner: string,
  outcome: 'response-received' | 'unknown',
  platformCode?: string,
  status?: number,
  endpoint?: 'profile' | 'list',
) {
  if (outcome === 'unknown' && !platformCode) return;
  if (
    platformCode &&
    !/^XHS_SOURCE_(AUTHENTICATION|VERIFICATION|UNKNOWN_REJECTION|PERMISSION|SIGNATURE|RATE_LIMIT)_BLOCKED$/.test(
      platformCode,
    )
  )
    throw Error('XHS_SOURCE_RISK_REVIEW_REQUIRED');
  const knownStatus =
    platformCode && [401, 403, 406, 429, 461, 471].includes(status ?? 0)
      ? status
      : null;
  if (
    (await tx.$executeRawUnsafe(
      "UPDATE xhs_source_risk SET state=?,owner=NULL,code=?,http_status=?,endpoint=?,updated_at=? WHERE id='source' AND state='pending' AND owner=?",
      platformCode ? 'blocked' : 'clear',
      platformCode ?? null,
      knownStatus,
      platformCode ? (endpoint ?? null) : null,
      BigInt(Date.now()),
      owner,
    )) !== 1
  )
    throw Error('XHS_SOURCE_RISK_UNAVAILABLE');
}
