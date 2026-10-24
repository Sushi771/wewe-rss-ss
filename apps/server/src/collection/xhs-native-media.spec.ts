import {
  chooseXhsNativeImage,
  selectXhsNativeDetail,
} from './xhs-native-media';
describe('ported full native image candidate selection (offline)', () => {
  it('rejects previews and upgrades only a proven candidate on the same allowlisted CDN', () => {
    expect(
      chooseXhsNativeImage({
        url_pre: 'https://sns-webpic.xhscdn.com/preview',
        info_list: [
          {
            url: 'http://sns-webpic-qc.xhscdn.com/full?synthetic=1',
            image_scene: 'WB_DFT',
            width: 1200,
            height: 900,
          },
        ],
      }),
    ).toBe('https://sns-webpic-qc.xhscdn.com/full?synthetic=1');
    expect(() =>
      chooseXhsNativeImage({
        url_pre: 'https://sns-webpic.xhscdn.com/preview',
        info_list: [
          {
            url: 'https://sns-webpic.xhscdn.com/thumb',
            image_scene: 'WB_PRV',
            width: 1200,
            height: 900,
          },
        ],
      }),
    ).toThrow('XHS_NATIVE_MEDIA_UNAVAILABLE');
  });
  it('prefers proven full dimensions and native large variants without requesting fallback candidates', () => {
    expect(
      chooseXhsNativeImage({
        width: 100,
        height: 100,
        url_default: 'https://sns-webpic.xhscdn.com/default',
        url_size_large: 'https://sns-webpic.xhscdn.com/large',
        info_list: [
          {
            url: 'https://sns-webpic.xhscdn.com/proven',
            image_scene: 'other',
            width: 200,
            height: 200,
          },
        ],
      }),
    ).toBe('https://sns-webpic.xhscdn.com/proven');
    expect(
      chooseXhsNativeImage({
        url_default: 'https://sns-webpic.xhscdn.com/default',
        url_size_large: 'https://sns-webpic.xhscdn.com/large',
      }),
    ).toBe('https://sns-webpic.xhscdn.com/large');
    expect(() =>
      chooseXhsNativeImage({
        info_list: [
          {
            url: 'https://sns-webpic.xhscdn.com/unconfirmed',
            image_scene: 'other',
            width: 200,
            height: 200,
          },
        ],
      }),
    ).toThrow();
  });
  it('uses native HTTPS before a larger HTTP compatibility candidate', () => {
    expect(
      chooseXhsNativeImage({
        url_default: 'https://sns-webpic.xhscdn.com/native',
        info_list: [
          {
            url: 'http://sns-webpic-qc.xhscdn.com/larger',
            image_scene: 'WB_DFT',
            width: 2000,
            height: 2000,
          },
        ],
      }),
    ).toBe('https://sns-webpic.xhscdn.com/native');
  });
  it('falls back only to a full candidate and preserves host, path, and query', () => {
    expect(
      chooseXhsNativeImage({
        url_pre: 'https://sns-webpic.xhscdn.com/preview',
        url_default: 'https://evil.test/full',
        info_list: [
          {
            url: 'http://sns-webpic-qc.xhscdn.com/full%2Fimage?synthetic=a%2Fb',
            image_scene: 'ND_DFT',
          },
        ],
      }),
    ).toBe('https://sns-webpic-qc.xhscdn.com/full%2Fimage?synthetic=a%2Fb');
    expect(() =>
      chooseXhsNativeImage({
        info_list: [
          {
            url: 'http://sns-webpic.xhscdn.com/preview',
            image_scene: 'WB_PRV',
          },
        ],
      }),
    ).toThrow('XHS_NATIVE_MEDIA_UNAVAILABLE');
  });
  it.each([
    'http://sns-webpic.xhscdn.com:80/image',
    'http://sns-webpic.xhscdn.com:80?synthetic=1',
    'https://sns-webpic.xhscdn.com:443/image',
    'http://sns-webpic.xhscdn.com:/image',
    'https://evil.test/full',
    'http://evil.test/full',
    'https://user@sns-webpic.xhscdn.com/full',
    'http://@sns-webpic.xhscdn.com/full',
    'https://127.0.0.1/full',
    'https://sns-webpic.xhscdn.com/full#fragment',
    'http://sns-webpic.xhscdn.com/full#',
    'http://sns-webpic.xhscdn.com/full%ZZ',
    'http://sns-webpic.xhscdn.com/full%E0%A4',
    'http://sns-webpic.xhscdn.com/full%00',
    'http://sns-webpic.xhscdn.com/full%5Cimage',
  ])('rejects candidate %s', (url) =>
    expect(() => chooseXhsNativeImage({ url_default: url })).toThrow(),
  );
  it('binds every slot to the exact author/note before mapping any media', () => {
    const raw = {
      items: [
        {
          id: 'synthetic-note',
          note_card: {
            note_id: 'synthetic-note',
            user: { user_id: 'synthetic-author' },
            image_list: [
              {
                image_info: {
                  info_list: [
                    {
                      url: 'http://sns-webpic.xhscdn.com/full',
                      image_scene: 'ND_DFT',
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    };
    expect(
      selectXhsNativeDetail(raw, 'synthetic-author', 'synthetic-note').items[0]
        .note_card.image_list[0].url_default,
    ).toBe('https://sns-webpic.xhscdn.com/full');
    expect(() =>
      selectXhsNativeDetail(raw, 'foreign', 'synthetic-note'),
    ).toThrow('XHS_NATIVE_DETAIL_INVALID');
    expect(() =>
      selectXhsNativeDetail(raw, 'synthetic-author', 'foreign'),
    ).toThrow();
  });
});
