export function isRedbookLocalHost(hostname: string) {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(
    hostname.toLowerCase(),
  );
}

/** Same-origin local-only submission. Never read stored authentication or retry. */
export async function redbookFirstCheckRequest<T>(
  action:
    | 'status'
    | 'session'
    | 'list'
    | 'detail'
    | 'images'
    | 'sample'
    | 'review'
    | 'discard',
  accessPassword: string,
  payload: object = {},
): Promise<T> {
  if (!isRedbookLocalHost(window.location.hostname) || !accessPassword)
    throw new Error('请在本机页面填写订阅平台的访问密码。');
  const response = await fetch(`/local/redbook/diagnostic/${action}`, {
    method: 'POST',
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    headers: {
      authorization: accessPassword,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok)
    throw new Error(
      '操作未完成。请读取本机状态；不会自动重试。若来源受限，请停止测试。',
    );
  return response.json() as Promise<T>;
}
