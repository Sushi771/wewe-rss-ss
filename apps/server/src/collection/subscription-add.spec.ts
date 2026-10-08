import {
  addNativeSubscription,
  subscriptionArticleUrl,
  SubscriptionDiscoveryValidator,
} from './subscription-add';

describe('subscription request / public response boundary', () => {
  it.each([
    'http://mp.weixin.qq.com/s/abc',
    'https://mp.weixin.qq.com.evil.test/s/abc',
    'https://user:secret@mp.weixin.qq.com/s/abc',
    'https://mp.weixin.qq.com:123/s/abc',
    'https://127.0.0.1/s/abc',
    'file:///s/abc',
    'https://mp.weixin.qq.com/mp/verify',
    'https://mp.weixin.qq.com/s?mid=1&mid=2',
    'https://mp.weixin.qq.com/s?pass_ticket=secret',
    'https://mp.weixin.qq.com/s?' + 'x'.repeat(4100),
  ])('rejects unsupported/private request %s before adapter', (url) => {
    expect(() => subscriptionArticleUrl(url)).toThrow();
  });
  it('passes a public short/long URL for actual server identity verification, never invents an ID', () => {
    expect(subscriptionArticleUrl(' https://mp.weixin.qq.com/s/unknown ')).toBe(
      'https://mp.weixin.qq.com/s/unknown',
    );
    expect(
      subscriptionArticleUrl(
        'https://mp.weixin.qq.com/s?__biz=MTIzNDU2&mid=1&idx=1',
      ),
    ).toContain('__biz=');
  });
  it('does not accept a success-shaped adapter reply without staged and activated Feed', async () => {
    const db = { feed: { create: jest.fn() }, $transaction: jest.fn() };
    const validator: SubscriptionDiscoveryValidator = {
      discover: async () => ({
        status: 'updated',
        stage: 'save',
        code: 'UPDATED',
        update: {
          articles: 10,
          created: 10,
          updated: 0,
          bodyMissing: 0,
          imageBlocked: 0,
          saved: true,
        },
      }),
    };
    const result = await addNativeSubscription(
      db as any,
      validator,
      {
        articleUrl: 'https://mp.weixin.qq.com/s/unknown',
        accountId: '123',
        trigger: 'local-manual-add',
      },
      jest.fn(),
    );
    expect(result).toMatchObject({
      accepted: false,
      status: 'failed',
      code: 'BINDING_FAILED',
      feed: null,
    });
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it('keeps numeric refusal evidence and excludes unknown fields, messages and secret-shaped codes', async () => {
    const validator = {
      discover: async () => ({
        status: 'blocked',
        stage: 'directory',
        code: 'Cookie=synthetic-secret',
        httpStatus: 200,
        businessCode: -2041,
        message: 'Authorization: synthetic-secret',
        raw: { token: 'synthetic-secret' },
        update: {
          articles: -1,
          created: 0,
          updated: 0,
          bodyMissing: 0,
          imageBlocked: 0,
          saved: true,
        },
      }),
    };
    const result = await addNativeSubscription(
      {} as any,
      validator as any,
      {
        articleUrl: 'https://mp.weixin.qq.com/s/unknown',
        accountId: '123',
        trigger: 'local-manual-add',
      },
      jest.fn(),
    );
    expect(result).toMatchObject({
      status: 'blocked',
      code: 'DISCOVERY_FAILED',
      httpStatus: 200,
      businessCode: -2041,
    });
    expect(result.update).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(
      /synthetic-secret|Authorization|Cookie|token/,
    );
  });
  it.each(['available', 'unavailable'])(
    'cleans original labels in %s verification responses',
    async (status) => {
      const url = 'https://mp.weixin.qq.com/s/abcdefghijklmnopqrstuv';
      const validator = {
        discover: async () => ({
          status: 'needs-verification',
          stage: 'identity',
          code: 'PUBLIC_ORIGINAL_VERIFICATION_REQUIRED',
          officialVerification:
            status === 'available'
              ? {
                  status,
                  articleUrl: url + '?pass_ticket=synthetic-secret',
                  url: 'https://mp.weixin.qq.com/mp/verify',
                  expiresAt: new Date(Date.now() + 60000).toISOString(),
                }
              : {
                  status,
                  articleUrl: url + '?pass_ticket=synthetic-secret',
                  reason: 'missing-location',
                },
        }),
      };
      const result = await addNativeSubscription(
        {} as any,
        validator as any,
        { articleUrl: url, accountId: '123', trigger: 'local-manual-add' },
        jest.fn(),
      );
      expect(result.officialVerification?.articleUrl).toBe(url);
      expect(JSON.stringify(result)).not.toContain('synthetic-secret');
    },
  );
});
