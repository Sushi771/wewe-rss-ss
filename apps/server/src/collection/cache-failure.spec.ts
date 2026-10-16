import { cacheFailureReason } from './cache-failure';
describe('safe cache failure diagnostics', () => {
  it.each([
    [
      { name: 'PrismaClientRustPanicError', message: 'private SQL' },
      'CACHE_STORAGE_ENGINE_ERROR',
    ],
    [{ code: 'P2028', message: 'private path' }, 'CACHE_STORAGE_TIMEOUT'],
    [{ code: 'P1008' }, 'CACHE_STORAGE_TIMEOUT'],
    [{ code: 'P2024' }, 'CACHE_STORAGE_TIMEOUT'],
    [
      new Error('SAVED_BODY_IMAGE_SOURCE_CONFLICT'),
      'CACHE_SAVED_IMAGE_CONFLICT',
    ],
    [new Error('WECHAT2RSS_REQUEST_FAILED'), 'CACHE_UPSTREAM_READ_ERROR'],
    [new Error('WECHAT2RSS_RESPONSE_TOO_LARGE'), 'CACHE_RESPONSE_TOO_LARGE'],
    [new Error('WECHAT2RSS_HTTP_STATUS'), 'CACHE_HTTP_STATUS'],
    [new Error('WECHAT2RSS_RATE_LIMITED'), 'CACHE_HTTP_STATUS'],
    [new Error('WECHAT2RSS_INVALID_JSON'), 'CACHE_INVALID_RESPONSE'],
    [new Error('WECHAT2RSS_INVALID_ENCODING'), 'CACHE_INVALID_RESPONSE'],
    [new Error('WECHAT2RSS_EMPTY_BODY'), 'CACHE_INVALID_RESPONSE'],
    [new Error('WECHAT2RSS_REQUEST_TIMEOUT'), 'CACHE_REQUEST_TIMEOUT'],
    [new Error('WECHAT2RSS_NETWORK_ERROR'), 'CACHE_NETWORK_ERROR'],
    [new Error('https://private.example/?token=secret'), 'CACHE_UNKNOWN_ERROR'],
    ['ARBITRARY_PROVIDER_ERROR', 'CACHE_UNKNOWN_ERROR'],
  ])('classifies without raw errors', (error, expected) => {
    expect(cacheFailureReason(error)).toBe(expected);
  });
});
