type Retry = {
  status: string;
  filled: boolean;
  requestFailure?: { reason: string; httpStatus?: number };
};

/** Presence is current state; an attempt is history, including after cache sync. */
export function articleBodyState(bodyCached: boolean, retry?: Retry | null) {
  const failure = retry?.requestFailure;
  let reason = '';
  if (failure?.reason === 'http_status') {
    const status = failure.httpStatus;
    reason =
      Number.isInteger(status) && status! >= 100 && status! <= 599
        ? `HTTP ${status}${status! >= 300 && status! < 400 ? ' 跳转，未跟随' : ''}`
        : '原文响应异常';
  } else {
    reason =
      (
        {
          timeout: '请求超时',
          connection_refused: '连接被拒绝',
          dns: '域名解析失败',
          network: '网络错误',
          invalid_response: '原文响应异常',
        } as Record<string, string>
      )[failure?.reason || ''] || '';
  }
  const history = !retry
    ? ''
    : retry.status === 'available'
      ? `上次原文重试：成功${retry.filled ? '，已补入正文' : ''}`
      : `上次原文重试：${retry.status === 'unavailable' ? '未取得正文' : '失败'}${reason ? `（${reason}）` : ''}；${bodyCached ? '当前缓存仍可阅读' : '当前无正文缓存'}`;
  return {
    current: bodyCached ? '正文已缓存，可阅读' : '正文未缓存',
    history,
    needsBody: !bodyCached,
  };
}
