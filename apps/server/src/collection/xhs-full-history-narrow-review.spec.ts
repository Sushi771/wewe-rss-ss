import {
  collectUnknowns,
  FULL_HISTORY_KIND,
  fullHistoryBudgetId,
} from './xhs-full-history-scope';
import {
  prepareFullHistoryNarrowReview,
  confirmFullHistoryNarrowReview,
} from './xhs-full-history-narrow-review';
it('inherits only matching receipt identity and retains genuine ambiguity', () => {
  const fence = {
    marker: 'm',
    phase: 'detail',
    noteId: 'n',
    state: 'started',
    receipt: { marker: 'm', phase: 'detail', outcome: 'unknown' },
  };
  const exact: any[] = [];
  collectUnknowns(fence, exact);
  expect(exact).toEqual([
    { phase: 'detail', target: 'n' },
    { phase: 'detail', target: 'n' },
  ]);
  for (const patch of [
    { marker: 'other' },
    { phase: 'media' },
    { noteId: 'conflict' },
    { targetHash: 'f'.repeat(64) },
    { marker: undefined },
    { marker: undefined, phase: undefined },
  ]) {
    const found: any[] = [];
    collectUnknowns(
      { ...fence, receipt: { ...fence.receipt, ...patch } },
      found,
    );
    expect(found.some((x) => x.target === '*')).toBe(true);
  }
  const unbound: any[] = [];
  collectUnknowns(fence.receipt, unbound);
  expect(unbound).toEqual([{ phase: 'detail', target: '*' }]);
});
it('appends proved narrower scope without changing old review, unknown or budget; rejects conflict and active collection', async () => {
  const reviewId = 'unbound-' + 'a'.repeat(64),
    bindings = ['a', 'b', 'c'].map((creatorId) => ({
      creatorId,
      jobId: 'job-' + creatorId,
    }));
  const scope: any = {
    reviewKind: FULL_HISTORY_KIND,
    bindings,
    maxRequests: 100,
    phaseLimits: { profile: 10, list: 20, detail: 50, media: 80 },
    sessionBinding: 'b'.repeat(64),
    exclusions: {
      a: [],
      b: [
        { phase: 'detail', target: '*' },
        { phase: 'detail', target: 'old-one' },
        { phase: 'detail', target: 'old-two' },
        { phase: 'detail', target: 'sha256:' + 'd'.repeat(64) },
      ],
      c: [],
    },
  };
  const reviews: any[] = [
    {
      id: reviewId,
      scope_json: JSON.stringify(scope),
      creator_bindings_json: JSON.stringify({
        a: 'author-a',
        b: 'author-b',
        c: 'author-c',
      }),
      backup_sha256: 'f'.repeat(64),
    },
  ];
  const jobs: any[] = bindings.map((b) => ({
    id: b.jobId,
    creator_id: b.creatorId,
    state: 'paused',
    updated_at: '1',
    document: JSON.stringify({
      sourceFence:
        b.creatorId === 'b'
          ? {
              marker: 'm',
              phase: 'detail',
              noteId: 'old-two',
              state: 'started',
              receipt: { marker: 'm', phase: 'detail', outcome: 'unknown' },
            }
          : null,
    }),
  }));
  const budgets: any[] = [
    {
      id: 'xhs:source-total',
      used: 9,
      request_limit: 1000,
      next_at: 0,
      interval_ms: 1000,
    },
    ...bindings.flatMap((b) => [
      {
        id: b.jobId,
        used: 2,
        request_limit: 30,
        next_at: 0,
        interval_ms: 1000,
      },
      {
        id: fullHistoryBudgetId(reviewId, b.jobId),
        used: 3,
        request_limit: 100,
        next_at: 1000,
        interval_ms: 1000,
      },
    ]),
  ];
  const requests: any[] = [
    {
      review_id: reviewId,
      phase: 'detail',
      creator_id: 'b',
      logical_target: 'old-one',
      outcome: 'unknown',
    },
  ];
  const tx: any = {
    $queryRawUnsafe: async (sql: string) => {
      if (sql.includes('FROM xhs_source_risk'))
        return [
          {
            id: 'source',
            state: 'clear',
            code: null,
            owner: null,
            http_status: null,
            endpoint: null,
            updated_at: 1,
          },
        ];
      if (sql.includes('FROM xhs_unbound_owner_reviews')) return reviews;
      if (sql.includes('FROM xhs_unbound_owner_requests'))
        return sql.includes('outcome IN') ? requests : requests;
      if (sql.includes('FROM xhs_whole_creator_jobs')) return jobs;
      if (sql.includes('FROM xhs_subscription_tasks')) return [];
      if (sql.includes('FROM xhs_creators'))
        return bindings.map((b) => ({
          id: b.creatorId,
          external_author_id: 'author-' + b.creatorId,
          enabled: 1,
        }));
      if (sql.includes('FROM xhs_request_budgets')) return budgets;
      throw Error(sql);
    },
    $executeRawUnsafe: async (sql: string, ...args: any[]) => {
      if (sql.includes('INSERT INTO xhs_unbound_owner_reviews'))
        reviews.push({
          id: args[0],
          scope_json: args[8],
          creator_bindings_json: args[6],
          backup_sha256: args[9],
        });
      else if (sql.includes('INSERT INTO xhs_request_budgets'))
        budgets.push({
          id: args[0],
          used: 0,
          request_limit: args[1],
          next_at: args[2],
          interval_ms: args[3],
        });
      else throw Error(sql);
      return 1;
    },
  };
  const input = {
    reviewId,
    creatorId: 'b',
    jobId: 'job-b',
    sessionBinding: 'e'.repeat(64),
  };
  const old = JSON.stringify({ reviews, budgets, requests });
  const plan = await prepareFullHistoryNarrowReview(tx, input);
  expect(plan.scope.exclusions.b.some((x: any) => x.target === '*')).toBe(
    false,
  );
  expect(plan.scope.exclusions.b).toEqual(
    expect.arrayContaining(
      scope.exclusions.b.filter((x: any) => x.target !== '*'),
    ),
  );
  expect(plan.scope.maxRequests).toBe(99);
  const host = {
    assertQuiescent: async () => {},
    assertSession: () => {},
    authorizePlan: async () => {},
    verifyProtectedSnapshot: async () => 'f'.repeat(64),
  };
  await expect(
    confirmFullHistoryNarrowReview(
      tx,
      {
        ...input,
        digest: '0'.repeat(64),
        acknowledgedUnknownExclusions: true,
        acknowledgedDuplicateDirectoryRead: true,
      },
      host,
      2n,
    ),
  ).rejects.toThrow('REVIEW_STATE_CHANGED');
  expect(JSON.stringify({ reviews, budgets, requests })).toBe(old);
  jobs[1].document = JSON.stringify({
    sourceFence: {
      marker: 'm',
      phase: 'detail',
      noteId: 'old-two',
      state: 'started',
      receipt: { marker: 'conflict', phase: 'detail', outcome: 'unknown' },
    },
  });
  await expect(prepareFullHistoryNarrowReview(tx, input)).rejects.toThrow(
    'UNBOUND_DETAIL_UNKNOWN_REMAINS',
  );
  jobs[1].document = JSON.stringify({
    sourceFence: {
      marker: 'm',
      phase: 'detail',
      noteId: 'old-two',
      state: 'started',
      receipt: { marker: 'm', phase: 'detail', outcome: 'unknown' },
    },
  });
  jobs[0].state = 'running';
  await expect(prepareFullHistoryNarrowReview(tx, input)).rejects.toThrow(
    'SOURCE_WORK_NOT_IDLE',
  );
  jobs[0].state = 'paused';
  const result = await confirmFullHistoryNarrowReview(
    tx,
    {
      ...input,
      digest: plan.digest,
      acknowledgedUnknownExclusions: true,
      acknowledgedDuplicateDirectoryRead: true,
    },
    host,
    2n,
  );
  expect(result.sourceRequestsSent).toBe(0);
  expect(reviews[0].scope_json).toBe(JSON.parse(old).reviews[0].scope_json);
  expect(budgets.slice(0, 7)).toEqual(JSON.parse(old).budgets);
  expect(requests).toEqual(JSON.parse(old).requests);
});
