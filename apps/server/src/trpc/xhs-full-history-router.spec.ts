import { ConfigService } from '@nestjs/config';
import { TrpcRouter } from './trpc.router';
import { TrpcService } from './trpc.service';
const ids = [1, 2, 3].map((n) => `00000000-0000-4000-8000-00000000000${n}`);
const input = {
  bindings: ids.map((id) => ({ creatorId: id, jobId: id })),
  maxRequests: 3000,
  phaseLimits: { profile: 6, list: 200, detail: 1000, media: 2500 },
};
function fixture(local = true) {
  const config = new ConfigService({
    auth: { code: 'synthetic' },
    platform: { url: '' },
    feed: { updateDelayTime: 0 },
  });
  const whole = {
    prepareKnownAuthProfileProbe: jest.fn(async () => ({
      digest: 'a'.repeat(64),
    })),
    confirmKnownAuthProfileProbe: jest.fn(async () => ({
      state: 'profile-saved',
    })),
    prepareWholeCreatorFullHistory: jest.fn(async () => ({
      digest: 'a'.repeat(64),
    })),
    confirmWholeCreatorFullHistory: jest.fn(async () => ({
      reviewId: 'unbound-' + 'a'.repeat(64),
    })),
    executeWholeCreatorFullHistory: jest.fn(async () => ({ state: 'queued' })),
  };
  const router = new TrpcRouter(
    new TrpcService({} as any, config, {} as any, {} as any),
    {} as any,
    config,
    {} as any,
    {} as any,
    undefined,
    undefined,
    undefined,
    undefined,
    whole as any,
  ).appRouter;
  return {
    router,
    whole,
    api: router.createCaller({ errorMsg: null, isLocalSave: local })
      .xiaohongshu,
  };
}
it('rejects remote full-history execution before the service can enqueue', async () => {
  const { api, whole } = fixture(false);
  await expect(
    api.executeWholeCreatorFullHistory({
      reviewId: 'unbound-' + 'a'.repeat(64),
      jobId: ids[0],
    }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(whole.executeWholeCreatorFullHistory).not.toHaveBeenCalled();
});
it('requires both explicit acknowledgements before confirming the immutable scope', async () => {
  const { api, whole } = fixture();
  await expect(
    api.confirmWholeCreatorFullHistory({
      ...input,
      digest: 'a'.repeat(64),
      acknowledgedUnknownScope: true,
    } as any),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(whole.confirmWholeCreatorFullHistory).not.toHaveBeenCalled();
});
it('passes only the strict bound local scope and rejects client session injection', async () => {
  const { api, whole } = fixture();
  await api.prepareWholeCreatorFullHistory(input);
  expect(whole.prepareWholeCreatorFullHistory).toHaveBeenCalledWith(input);
  await expect(
    api.prepareWholeCreatorFullHistory({
      ...input,
      sessionBinding: 'client-claims-session',
    } as any),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(whole.prepareWholeCreatorFullHistory).toHaveBeenCalledTimes(1);
});

it.each([
  'prepareKnownResponseAuthReview',
  'confirmKnownResponseAuthReview',
  'prepareKnownAuthProfileProbe',
  'confirmKnownAuthProfileProbe',
])(
  'does not expose the retired pre-verification clear/probe route: %s',
  (name) => {
    for (const local of [true, false]) {
      const { router, whole } = fixture(local);
      expect(router._def.procedures['xiaohongshu.' + name]).toBeUndefined();
      expect(whole.prepareKnownAuthProfileProbe).not.toHaveBeenCalled();
      expect(whole.confirmKnownAuthProfileProbe).not.toHaveBeenCalled();
    }
  },
);
