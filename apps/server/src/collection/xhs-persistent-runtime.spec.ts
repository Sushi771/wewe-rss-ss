import { XhsSubscriptionRuntime } from './xhs-subscription-runtime';
const cookies = { a1: 'synthetic-a1', web_session: 'synthetic-session' };
function fixture(autoRestore = false, needsReconnect = false) {
  const vault = {
    status: jest.fn(async () => ({ stored: true })),
    store: jest.fn(async () => {}),
    replace: jest.fn(async () => {}),
    load: jest.fn(async () => ({ ...cookies })),
    disconnect: jest.fn(async () => {}),
    policy: jest.fn(async () => ({ autoRestore, needsReconnect })),
    configureRestore: jest.fn(async () => {}),
    markExpired: jest.fn(async () => {}),
  };
  const api = jest.fn();
  const runtime = new XhsSubscriptionRuntime({
    enabled: () => true,
    vault,
    api,
  });
  return { runtime, vault, api };
}
it('restores only explicit opt-in at startup without source requests or authentication claims', async () => {
  const { runtime, vault, api } = fixture(true);
  await runtime.onModuleInit();
  const status = await runtime.connectionStatus();
  expect(status.sessionPresent).toBe(true);
  expect(status.verified).toBe(false);
  expect(vault.load).toHaveBeenCalledTimes(1);
  expect(api).not.toHaveBeenCalled();
  expect(() => runtime.replacementSessionForReview()).toThrow();
  runtime.onModuleDestroy();
});
it.each([
  [false, false],
  [true, true],
])(
  'does not read old or expired saved secrets (%s,%s)',
  async (autoRestore, needsReconnect) => {
    const { runtime, vault, api } = fixture(autoRestore, needsReconnect);
    await runtime.onModuleInit();
    expect((await runtime.connectionStatus()).sessionPresent).toBe(false);
    expect(vault.load).not.toHaveBeenCalled();
    expect(api).not.toHaveBeenCalled();
    runtime.onModuleDestroy();
  },
);
it('uses explicit encrypted replacement and opt-in only when persisting', async () => {
  const { runtime, vault, api } = fixture();
  await runtime.onModuleInit();
  await runtime.connectSession({
    a1: cookies.a1,
    webSession: cookies.web_session,
    persist: true,
    replaceSaved: true,
    autoRestore: true,
  });
  expect(vault.replace).toHaveBeenCalledTimes(1);
  expect(vault.configureRestore).toHaveBeenCalledWith(true);
  expect(vault.store).not.toHaveBeenCalled();
  expect(api).not.toHaveBeenCalled();
  runtime.onModuleDestroy();
});
it('keeps memory-only connection free of persistent writes and rejects implicit persistence options', async () => {
  const { runtime, vault } = fixture();
  await runtime.connectSession({
    a1: cookies.a1,
    webSession: cookies.web_session,
    persist: false,
  });
  expect(vault.store).not.toHaveBeenCalled();
  expect(vault.replace).not.toHaveBeenCalled();
  expect(vault.configureRestore).not.toHaveBeenCalled();
  await expect(
    runtime.connectSession({
      a1: cookies.a1,
      webSession: cookies.web_session,
      persist: false,
      autoRestore: true,
    }),
  ).rejects.toThrow();
  runtime.onModuleDestroy();
});
it('reveals only through explicit savedSession without source requests', async () => {
  const { runtime, vault, api } = fixture();
  expect(await runtime.savedSession()).toEqual({ a1: cookies.a1, webSession: cookies.web_session });
  expect(vault.load).toHaveBeenCalledTimes(1);
  expect(api).not.toHaveBeenCalled();
  runtime.onModuleDestroy();
});
