beforeAll(
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- Existing native self fixture; synthetic session only.
  require('../../../../scripts/local-release/writer-self.fixture.test.cjs')
    .prepareWriterSelf,
);
import { XhsSubscriptionRuntime } from './xhs-subscription-runtime';

it('manual memory-only connection preserves rejection without vault writes or source requests', async () => {
  const storage = {
    status: jest.fn(async () => ({ stored: true })),
    store: jest.fn(async () => {}),
    load: jest.fn(async () => ({
      a1: 'unused-synthetic',
      web_session: 'unused-synthetic',
    })),
    disconnect: jest.fn(async () => {}),
  };
  const api = jest.fn(async () => {
    throw Error('NO_SOURCE_REQUEST_ALLOWED');
  });
  const risk = {
    read: jest.fn(async () => 'XHS_SOURCE_AUTHENTICATION_BLOCKED'),
    clear: jest.fn(),
    begin: jest.fn(),
    finish: jest.fn(),
  };
  const runtime = new XhsSubscriptionRuntime({
    enabled: () => true,
    vault: storage,
    api,
  });
  runtime.bindRiskStore(risk as any);
  await runtime.connectionStatus();
  const result = await runtime.connectSession({
    a1: 'synthetic-new-a1',
    webSession: 'synthetic-new-session',
    persist: false,
  });
  expect(result.connected).toBe(true);
  expect(result.riskCode).toBe('XHS_SOURCE_AUTHENTICATION_BLOCKED');
  expect(result.verified).toBe(false);
  expect(storage.store).not.toHaveBeenCalled();
  expect(storage.load).not.toHaveBeenCalled();
  expect(storage.disconnect).not.toHaveBeenCalled();
  expect(risk.clear).not.toHaveBeenCalled();
  expect(risk.begin).not.toHaveBeenCalled();
  expect(risk.finish).not.toHaveBeenCalled();
  expect(api).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain('synthetic-new');
  const first = runtime.replacementSessionForReview();
  expect(first.binding).toMatch(/^[a-f0-9]{64}$/);
  expect(() =>
    runtime.assertReplacementSession(
      first.binding,
      BigInt(first.connectedAt + 1),
    ),
  ).toThrow('XHS_SESSION_CHANGED');
  await expect(
    runtime.refreshAfterAuthSessionReview(first.binding),
  ).rejects.toThrow('XHS_SOURCE_RISK_REVIEW_REQUIRED');
  await runtime.connectSession({
    a1: 'synthetic-second',
    webSession: 'synthetic-second',
    persist: false,
  });
  expect(() => runtime.assertReplacementSession(first.binding)).toThrow(
    'XHS_SESSION_CHANGED',
  );
  const second = runtime.replacementSessionForReview();
  risk.read.mockImplementation(async () => undefined as any);
  await runtime.refreshAfterAuthSessionReview(second.binding);
  expect((await runtime.connectionStatus()).verified).toBe(false);
  expect(api).not.toHaveBeenCalled();
  await runtime.onModuleDestroy();
  expect(() => runtime.replacementSessionForReview()).toThrow(
    'XHS_SESSION_CHANGED',
  );
});
