import { SubscriptionProvider } from './subscription-provider';
import { Wechat2RssProvider } from './providers/wechat2rss';

/** Explicit environment gate and feed allowlist. Missing settings never select a legacy source. */
export function enabledWechat2RssFeedIds(): Set<string> {
  if (process.env.WECHAT2RSS_ENABLED !== '1') return new Set();
  return new Set(
    (process.env.WECHAT2RSS_FEED_IDS || '')
      .split(',')
      .map((v) => v.trim())
      .filter((v) => /^MP_WXS_\d{5,15}$/.test(v)),
  );
}

export function wechat2RssProvider(): SubscriptionProvider {
  if (process.env.WECHAT2RSS_ENABLED !== '1')
    throw new Error('WECHAT2RSS_DISABLED');
  return new Wechat2RssProvider(
    process.env.WECHAT2RSS_BASE_URL || '',
    process.env.WECHAT2RSS_TOKEN || '',
  );
}
