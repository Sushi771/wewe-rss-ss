/** Use only a stored official article URL; an internal article ID is not a URL. */
export function wechatOriginalUrl(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    !value ||
    Array.from(value).some(
      (character) =>
        character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    )
  )
    return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'mp.weixin.qq.com' ||
      url.port ||
      url.username ||
      url.password ||
      !(
        /^\/s\/[^/]+$/.test(url.pathname) ||
        (url.pathname === '/s' &&
          ['__biz', 'mid', 'idx'].every((key) => url.searchParams.get(key)))
      )
    )
      return undefined;
    return value;
  } catch {
    return undefined;
  }
}
