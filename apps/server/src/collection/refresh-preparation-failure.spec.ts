import {
  refreshPreparationFailure,
  refreshPreparationOutcome,
  validRefreshPreparationFailure,
} from './refresh-preparation-failure';

describe('bounded preparation diagnostics', () => {
  it.each(['WECHAT2RSS_NETWORK_ERROR', 'WECHAT2RSS_REQUEST_TIMEOUT'])(
    '%s keeps the existing retry policy',
    (code) => {
      expect(
        refreshPreparationOutcome(new Error(code), 'account-status'),
      ).toMatchObject({
        state: 'failed',
        retryable: true,
        stopBatch: false,
        accepted: false,
        submissionUnknown: false,
        preparationFailure: { code, stage: 'account-status' },
      });
    },
  );
  it('stopped protection is blocked, not a successful skip or a new unknown submit', () => {
    expect(
      refreshPreparationOutcome(
        new Error('WECHAT2RSS_SOURCE_STOPPED'),
        'account-status',
      ),
    ).toMatchObject({
      state: 'blocked',
      retryable: false,
      stopBatch: true,
      accepted: false,
      submissionUnknown: false,
    });
    expect(
      refreshPreparationOutcome(
        new Error('WECHAT2RSS_RATE_LIMITED'),
        'subscription-check',
      ),
    ).toMatchObject({
      state: 'blocked',
      retryable: false,
      stopBatch: true,
      sharedRestriction: true,
      restrictionKind: 'rate-limit',
    });
  });
  it.each([null, undefined, 42, { message: 'WECHAT2RSS_SOURCE_STOPPED' }])(
    'unknown %p remains retryable and sanitized',
    (error) => {
      expect(
        refreshPreparationOutcome(error, 'prepare-callback'),
      ).toMatchObject({
        retryable: true,
        stopBatch: false,
        preparationFailure: {
          code: 'REFRESH_PREPARATION_FAILED',
          stage: 'prepare-callback',
        },
      });
    },
  );
  it('never serializes arbitrary secrets, paths, SQL, causes, stack or getters', () => {
    const error = new Error(
      'http://synthetic/?k=DO_NOT_PERSIST C:\\private\\fixture.db SELECT private',
    );
    Object.assign(error, {
      code: 'DO_NOT_PERSIST',
      cause: new Error('DO_NOT_PERSIST'),
    });
    const outcome = refreshPreparationOutcome(error, 'reservation');
    expect(JSON.stringify(outcome)).not.toMatch(
      /DO_NOT_PERSIST|private|SELECT|stack|cause/,
    );
    expect(outcome.preparationFailure).toEqual({
      code: 'REFRESH_PREPARATION_FAILED',
      stage: 'reservation',
    });
    const getter = new Error();
    Object.defineProperty(getter, 'message', {
      get: () => {
        throw Error('GETTER_FORBIDDEN');
      },
    });
    expect(refreshPreparationFailure(getter, 'claim-read')).toEqual({
      code: 'REFRESH_PREPARATION_FAILED',
      stage: 'claim-read',
    });
  });
  it('accepts only the exact durable two-field allowlist', () => {
    const valid = {
      code: 'WECHAT2RSS_SOURCE_STOPPED',
      stage: 'account-status',
    };
    expect(validRefreshPreparationFailure(valid)).toBe(true);
    for (const invalid of [
      { ...valid, stack: 'x' },
      { ...valid, code: 'untrusted' },
      { ...valid, stage: 'untrusted' },
      { code: valid.code },
      [],
      null,
    ])
      expect(validRefreshPreparationFailure(invalid)).toBe(false);
  });
});
