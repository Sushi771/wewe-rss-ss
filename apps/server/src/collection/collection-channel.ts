type ChannelFeed = {
  id: string;
  collectionChannel?: string | null;
  publicAlbumIds?: string | null;
  localDirectory?: string | null;
};

export type CollectionRoute = {
  channel: 'mp2rss' | 'public-album' | 'unavailable';
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

/** 旧桌面选择仅作为历史值读取；新更新统一走后台来源。 */
export function resolveCollectionRoute(feed: ChannelFeed): CollectionRoute {
  if (feed.collectionChannel != null) {
    if (
      feed.collectionChannel === 'desktop-wechat' ||
      feed.collectionChannel === 'mp2rss'
    )
      return { channel: 'mp2rss', selectedBy: 'saved' };
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
  return { channel: 'mp2rss', selectedBy: 'legacy' };
}
