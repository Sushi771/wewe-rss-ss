type ChannelFeed = {
  id: string;
  collectionChannel?: string | null;
  publicAlbumIds?: string | null;
  localDirectory?: string | null;
};

export type CollectionRoute = {
  channel: 'desktop-wechat' | 'public-album' | 'cover' | 'unavailable';
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

/** 通道选择不代表覆盖完整、桌面授权有效或已通过定时验收。 */
export function resolveCollectionRoute(
  feed: ChannelFeed,
  desktopMpIds = process.env.WECHAT_DESKTOP_MP_IDS || '',
): CollectionRoute {
  if (feed.collectionChannel != null) {
    if (feed.collectionChannel === 'desktop-wechat')
      return { channel: feed.collectionChannel, selectedBy: 'saved' };
    if (
      feed.collectionChannel === 'public-album' &&
      parseBoundAlbumIds(feed.publicAlbumIds)
    )
      return { channel: 'public-album', selectedBy: 'saved' };
    // 未知持久值不能静默回退为封面、旧合集或桌面操作。
    return { channel: 'unavailable', selectedBy: 'invalid' };
  }
  if (desktopMpIds.split(',').some((id) => id.trim() === feed.id))
    return { channel: 'desktop-wechat', selectedBy: 'environment' };
  if (feed.publicAlbumIds)
    return parseBoundAlbumIds(feed.publicAlbumIds)
      ? { channel: 'public-album', selectedBy: 'legacy' }
      : { channel: 'unavailable', selectedBy: 'invalid' };
  if (feed.localDirectory)
    return { channel: 'unavailable', selectedBy: 'legacy' };
  return { channel: 'cover', selectedBy: 'legacy' };
}
