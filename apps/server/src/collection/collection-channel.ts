import { enabledWechat2RssFeedIds } from './provider-registry';

type ChannelFeed = {
  id: string;
  collectionChannel?: string | null;
  publicAlbumIds?: string | null;
  localDirectory?: string | null;
};

export type CollectionRoute = {
  channel:
    | 'wechat2rss'
    | 'public-album'
    | 'owner-web-search'
    | 'owner-weread-latest'
    | 'unavailable';
  selectedBy: 'saved' | 'environment' | 'legacy' | 'invalid';
};

export function parseBoundAlbumIds(
  raw: string | null | undefined,
): string[] | undefined {
  try {
    const ids: unknown = JSON.parse(raw || 'null');
    if (
      Array.isArray(ids) &&
      ids.length > 0 &&
      ids.length <= 10 &&
      ids.every((id) => typeof id === 'string' && /^\d{10,30}$/.test(id))
    )
      return ids;
  } catch {
    // 配置无效时不改用另一来源。
  }
  return undefined;
}

/** Existing legacy values are historical. Only an explicitly enabled feed uses Wechat2RSS. */
export function resolveCollectionRoute(feed: ChannelFeed): CollectionRoute {
  const enabled = enabledWechat2RssFeedIds().has(feed.id);
  if (feed.collectionChannel != null) {
    if (feed.collectionChannel === 'owner-weread-latest')
      return { channel: 'owner-weread-latest', selectedBy: 'saved' };
    if (feed.collectionChannel === 'owner-web-search')
      return { channel: 'owner-web-search', selectedBy: 'saved' };
    if (feed.collectionChannel === 'wechat2rss')
      return process.env.WECHAT2RSS_ENABLED === '1'
        ? { channel: 'wechat2rss', selectedBy: 'saved' }
        : { channel: 'unavailable', selectedBy: 'invalid' };
    if (
      feed.collectionChannel === 'public-album' &&
      parseBoundAlbumIds(feed.publicAlbumIds)
    )
      return { channel: 'public-album', selectedBy: 'saved' };
    // 未知持久值不能静默回退到另一来源。
    return { channel: 'unavailable', selectedBy: 'invalid' };
  }
  if (feed.publicAlbumIds)
    return parseBoundAlbumIds(feed.publicAlbumIds)
      ? { channel: 'public-album', selectedBy: 'legacy' }
      : { channel: 'unavailable', selectedBy: 'invalid' };
  return enabled
    ? { channel: 'wechat2rss', selectedBy: 'environment' }
    : { channel: 'unavailable', selectedBy: 'legacy' };
}
