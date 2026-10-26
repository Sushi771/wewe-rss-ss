export function originalLinkMessage(code?: string): string {
  switch (code) {
    case 'XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED':
      return '来源 API 拒绝了请求，原因尚不明确；采集已停止，请先核查来源状态。';
    case 'XHS_SOURCE_VERIFICATION_BLOCKED':
      return '来源明确提示需要验证，但当前没有可确认的验证入口；请先核查来源状态。';
    case 'XHS_REQUEST_BUDGET_REQUIRED':
      return '请先设置来源请求额度，再重试。';
    case 'XHS_REQUEST_BUDGET_EXHAUSTED':
      return '来源请求额度已用完，请在设置中调整总额度。';
    case 'XHS_REQUEST_RATE_PAUSED':
      return '请求间隔尚未到，请稍后再试。';
    case 'XHS_BUDGET_SCOPE_MISMATCH':
      return '来源额度与此笔记不匹配，请重新打开设置。';
    case 'XHS_NOTE_ID_INVALID':
    case 'XHS_SUBSCRIPTION_REQUIRED':
    case 'XHS_AUTHOR_MISMATCH':
      return '笔记来源信息不足，暂时无法打开原文。';
    case 'XHS_ACCESS_CONTEXT_EXPIRED':
      return '原文链接已过期，请稍后重新准备。';
    case 'XHS_SESSION_REQUIRED':
    case 'XHS_SESSION_CHANGED':
      return '来源连接已失效，请检查本机连接。';
    case 'XHS_LIVE_ACCESS_DISABLED':
      return '来源访问尚未启用，请检查连接设置。';
    default:
      return code && /^XHS_SOURCE_[A-Z_]+_BLOCKED$/.test(code)
        ? '来源暂时限制访问，请先处理本机连接状态。'
        : '原文暂时无法打开，请稍后重试。';
  }
}

export function noteArchiveStatus(note: {
  status: string;
  kind: 'image-text' | 'video';
}) {
  return note.status === 'complete'
    ? note.kind === 'video'
      ? '视频已归档（播放未验证）'
      : '图文已归档'
    : note.kind === 'video' || note.status === 'video-skipped'
      ? '目录记录 · 视频未归档'
      : '目录记录 · 正文/媒体未完整归档';
}

/** Accept only the exact saved note on the official HTTPS web origin.
 * Source query parameters are preserved; never construct or log access tokens. */
export function verifiedOriginalUrl(
  noteId: string,
  value: string,
): string | undefined {
  try {
    if (
      !value ||
      value.length > 8192 ||
      /[\\\s]/.test(value) ||
      Array.from(value).some(
        (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
      ) ||
      /^https:\/\/[^/]*:\d+(?:\/|$)/i.test(value)
    )
      return undefined;
    const key: unknown = JSON.parse(noteId);
    const url = new URL(value);
    if (
      !Array.isArray(key) ||
      key.length !== 3 ||
      key[0] !== 'xiaohongshu' ||
      key[1] !== 'note' ||
      typeof key[2] !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(key[2]) ||
      JSON.stringify(key) !== noteId
    )
      return undefined;
    if (
      url.protocol !== 'https:' ||
      url.port ||
      url.username ||
      url.password ||
      (url.hash && url.hash !== '#comment-section')
    )
      return undefined;
    if (['xhslink.com', 'xhslink.cn'].includes(url.hostname)) {
      if (url.search || url.hash) return undefined;
      return (url.hostname === 'xhslink.com'
        ? /^\/(?:a\/)?[a-zA-Z0-9_-]{1,128}\/?$/
        : /^\/o\/[a-zA-Z0-9_-]{1,128}\/?$/
      ).test(url.pathname)
        ? url.href
        : undefined;
    }
    if (
      url.protocol !== 'https:' ||
      !['www.xiaohongshu.com', 'xiaohongshu.com'].includes(url.hostname) ||
      url.port ||
      url.username ||
      url.password ||
      ![`/explore/${key[2]}`, `/discovery/item/${key[2]}`].includes(
        url.pathname,
      )
    )
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
