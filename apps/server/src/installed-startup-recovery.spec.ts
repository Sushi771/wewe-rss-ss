import { waitForStartupAudit } from './startup-audit';
import { XhsSubscriptionService } from './collection/xhs-subscription.service';
import { XhsWholeCreatorService } from './collection/xhs-whole-creator.service';
import { XhsBatchSubscriptionService } from './collection/xhs-batch-subscription.service';

describe('installed read-only startup recovery', () => {
  const key = Symbol.for('wewe.installed-startup-gate.v1');
  const global = globalThis as any;
  let allow: (ok: boolean) => void;
  let enabled: boolean;
  beforeEach(() => {
    enabled = false;
    const ready = new Promise<boolean>((resolve) => {
      allow = resolve;
    });
    global[key] = {
      writesAllowed: () => enabled,
      waitUntilEnabled: () => ready,
    };
  });
  afterEach(() => {
    delete global[key];
  });
  it('does not resolve startup permission before the installed writer gate', async () => {
    const settled = jest.fn();
    const promise = waitForStartupAudit().then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    allow(false);
    await promise;
    expect(settled).toHaveBeenCalledWith(false);
  });
  it.each([XhsSubscriptionService, XhsWholeCreatorService])(
    '%p permits HTTP bootstrap without reading or writing interrupted tasks',
    async (Service) => {
      const service = Object.create(Service.prototype);
      service.recoverInterrupted = jest.fn().mockResolvedValue(undefined);
      await service.onModuleInit();
      expect(service.recoverInterrupted).not.toHaveBeenCalled();
      enabled = true;
      allow(true);
      await service.startupRecovery;
      expect(service.recoverInterrupted).toHaveBeenCalledTimes(1);
    },
  );
  it('defers batch recovery instead of permanently failing initialization during the hold', async () => {
    const service = Object.create(XhsBatchSubscriptionService.prototype);
    service.db = { $queryRaw: jest.fn().mockResolvedValue([]) };
    await service.onModuleInit();
    expect(service.db.$queryRaw).not.toHaveBeenCalled();
    enabled = true;
    allow(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(service.db.$queryRaw).toHaveBeenCalledTimes(1);
    expect(service.initializationFailed).not.toBe(true);
  });
});
