import { XhsSubscriptionRuntime } from './xhs-subscription-runtime';
import type { XhsSessionVault } from './xhs-session-vault';

const cookies = { a1: 'synthetic-a1', web_session: 'synthetic-session' };
function fixture() {
  let stored = true,
    policy = { autoRestore: true, needsReconnect: true };
  const api = jest.fn(async () => {
    throw Error('SOURCE_FORBIDDEN');
  });
  const vault = {
    status: jest.fn(async () => ({ stored })),
    store: jest.fn(async () => {
      stored = true;
      policy.needsReconnect = false;
    }),
    replace: jest.fn(async () => {
      stored = true;
      policy.needsReconnect = false;
    }),
    configureRestore: jest.fn(async (value: boolean) => {
      policy.autoRestore = value;
    }),
    policy: jest.fn(async () => ({ ...policy })),
    load: jest.fn(async () => ({ ...cookies })),
    disconnect: jest.fn(async () => {
      stored = false;
    }),
  };
  const runtime = new XhsSubscriptionRuntime({
    enabled: () => true,
    api,
    vault,
  });
  const connect = (persist = false) =>
    runtime.connectSession({
      a1: cookies.a1,
      webSession: cookies.web_session,
      ...(persist
        ? { persist: true, replaceSaved: true, autoRestore: true }
        : {}),
    });
  return {
    runtime,
    vault,
    api,
    policy,
    connect,
    absent: () => {
      stored = false;
    },
  };
}
it.each(['expired', 'missing-policy', 'policy-error', 'expired-after-load'])(
  'manual restore rejects %s and preserves current replacement memory',
  async (mode) => {
    const f = fixture();
    try {
      await f.connect();
      const before = f.runtime.replacementSessionForReview();
      if (mode === 'missing-policy')
        (f.vault as Partial<XhsSessionVault>).policy = undefined;
      if (mode === 'policy-error')
        f.vault.policy.mockRejectedValue(Error('POLICY_FAILED'));
      if (mode === 'expired-after-load') {
        f.policy.needsReconnect = false;
        f.vault.load.mockImplementation(async () => {
          f.policy.needsReconnect = true;
          return { ...cookies };
        });
      }
      await expect(f.runtime.restoreSession()).rejects.toThrow();
      expect(f.runtime.replacementSessionForReview()).toEqual(before);
      expect(f.vault.load).toHaveBeenCalledTimes(
        mode === 'expired-after-load' ? 1 : 0,
      );
      expect(f.api).not.toHaveBeenCalled();
    } finally {
      f.runtime.onModuleDestroy();
    }
  },
);
it('memory-only review requires expired or absent saved credentials, never merely a policy flag for saved-new proof', async () => {
  const f = fixture();
  try {
    await f.connect();
    const b = f.runtime.replacementSessionForReview().binding;
    await f.runtime.assertSafeAuthSessionRestore(b);
    f.policy.needsReconnect = false;
    await expect(f.runtime.assertSafeAuthSessionRestore(b)).rejects.toThrow();
    f.absent();
    await f.runtime.assertSafeAuthSessionRestore(b);
    expect(f.vault.load).not.toHaveBeenCalled();
    expect(f.vault.store).not.toHaveBeenCalled();
    expect(f.api).not.toHaveBeenCalled();
  } finally {
    f.runtime.onModuleDestroy();
  }
});
it('explicit saved replacement proves same binding/read-back policy and safely restores on restart without source probes', async () => {
  const f = fixture();
  let restarted: XhsSubscriptionRuntime | undefined;
  try {
    await f.connect(true);
    const s = f.runtime.replacementSessionForReview();
    expect(s).toMatchObject({ persisted: true, autoRestore: true });
    await f.runtime.assertSafeAuthSessionRestore(s.binding);
    expect(f.vault.replace).toHaveBeenCalledTimes(1);
    expect(f.vault.configureRestore).toHaveBeenCalledWith(true);
    f.runtime.onModuleDestroy();
    restarted = new XhsSubscriptionRuntime({
      enabled: () => true,
      api: f.api,
      vault: f.vault,
    });
    await restarted.onModuleInit();
    expect(await restarted.connectionStatus()).toMatchObject({
      connected: true,
      verified: false,
    });
    expect(f.vault.load).toHaveBeenCalledTimes(1);
    expect(f.api).not.toHaveBeenCalled();
    expect(() => restarted!.replacementSessionForReview()).toThrow();
    const known = restarted.knownAuthSessionForReview();
    expect(known.origin).toBe('user-confirmed-restored-saved-session');
    expect(known.binding).not.toBe(s.binding);
    await restarted.assertSafeKnownAuthSession(known.binding);
    expect(f.vault.load).toHaveBeenCalledTimes(1);
    expect(f.vault.replace).toHaveBeenCalledTimes(1);
    f.policy.needsReconnect = true;
    await expect(
      restarted.assertSafeKnownAuthSession(known.binding),
    ).rejects.toThrow();
  } finally {
    restarted?.onModuleDestroy();
    f.runtime.onModuleDestroy();
  }
});
it.each([
  'old-binding',
  'missing-origin',
  'expired',
  'auto-restore-drift',
  'policy-read-failed',
])(
  'known restored-session proof rejects %s without loading or rewriting secrets',
  async (mode) => {
    const f = fixture();
    try {
      f.policy.needsReconnect = false;
      await f.runtime.restoreSession();
      const known = f.runtime.knownAuthSessionForReview();
      if (mode === 'missing-origin')
        (f.runtime as any).restoredKnownSession = undefined;
      if (mode === 'expired') f.policy.needsReconnect = true;
      if (mode === 'auto-restore-drift')
        f.policy.autoRestore = !f.policy.autoRestore;
      if (mode === 'policy-read-failed')
        f.vault.policy.mockRejectedValue(Error('POLICY_FAILED'));
      await expect(
        f.runtime.assertSafeKnownAuthSession(
          mode === 'old-binding' ? 'f'.repeat(64) : known.binding,
        ),
      ).rejects.toThrow();
      expect(() => f.runtime.replacementSessionForReview()).toThrow();
      expect(f.vault.load).toHaveBeenCalledTimes(1);
      expect(f.vault.store).not.toHaveBeenCalled();
      expect(f.vault.replace).not.toHaveBeenCalled();
      expect(f.api).not.toHaveBeenCalled();
    } finally {
      f.runtime.onModuleDestroy();
    }
  },
);
it('does not promote an unsuccessful saved-policy proof, and rejects later policy drift', async () => {
  const f = fixture();
  try {
    f.vault.configureRestore.mockImplementation(async () => {
      f.policy.autoRestore = false;
    });
    await f.connect(true);
    const s = f.runtime.replacementSessionForReview();
    expect(s.persisted).toBe(false);
    await expect(
      f.runtime.assertSafeAuthSessionRestore(s.binding),
    ).rejects.toThrow();
    expect(f.api).not.toHaveBeenCalled();
  } finally {
    f.runtime.onModuleDestroy();
  }
});
it.each(
  ['changed-session', 'new-risk', 'wrong-version', 'risk-read-error'].flatMap(
    (mode) =>
      (
        ['refreshAfterAuthSessionReview', 'refreshKnownAuthSession'] as const
      ).map((method) => [mode, method] as const),
  ),
)(
  'post-commit refresh rejects %s before clearing memory (%s)',
  async (mode, method) => {
    const f = fixture();
    try {
      await f.connect();
      const binding = f.runtime.replacementSessionForReview().binding;
      (f.runtime as any).stopCode = 'XHS_SOURCE_AUTHENTICATION_BLOCKED';
      (f.runtime as any).persistedRisk = 'XHS_SOURCE_AUTHENTICATION_BLOCKED';
      f.runtime.bindRiskStore({
        readClearVersion: async () => {
          if (mode === 'changed-session') await f.connect();
          if (mode === 'new-risk')
            (f.runtime as any).persistedRisk =
              'XHS_SOURCE_VERIFICATION_BLOCKED';
          if (mode === 'risk-read-error') throw Error('RISK_READ_FAILED');
          return mode === 'wrong-version' ? '401' : '400';
        },
      } as any);
      await expect(f.runtime[method](binding, '400')).rejects.toThrow();
      expect((f.runtime as any).stopCode).toBe(
        'XHS_SOURCE_AUTHENTICATION_BLOCKED',
      );
      expect((f.runtime as any).persistedRisk).toBe(
        mode === 'new-risk'
          ? 'XHS_SOURCE_VERIFICATION_BLOCKED'
          : 'XHS_SOURCE_AUTHENTICATION_BLOCKED',
      );
      expect(f.api).not.toHaveBeenCalled();
    } finally {
      f.runtime.onModuleDestroy();
    }
  },
);
