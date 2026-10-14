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
  signal?: AbortSignal,
): Promise<T> {
  if (!isRedbookLocalHost(window.location.hostname) || !accessPassword)
    throw new Error('请在本机页面填写订阅平台的访问密码。');
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timeout = setTimeout(abort, 30000);
  try {
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
      signal: controller.signal,
    });
    if (!response.ok)
      throw new Error(
        '操作未完成。请读取本机状态；不会自动重试。若来源受限，请停止测试。',
      );
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export const REDBOOK_DIAGNOSTIC_TTL_MS = 24 * 3600000;

/** Display only the provisional detail shape already consumed by the server.
 * This projection makes no assertion about authenticity or completeness.
 */
export function redbookDiagnosticDetail(raw: unknown) {
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const detail = record(raw);
  if (!Array.isArray(detail?.items) || detail.items.length !== 1) return;
  const item = record(detail.items[0]);
  const card = record(item?.note_card);
  if (
    !card ||
    card.type !== 'normal' ||
    typeof card.note_id !== 'string' ||
    item?.id !== card.note_id ||
    typeof card.title !== 'string' ||
    typeof card.desc !== 'string' ||
    typeof card.time !== 'number' ||
    !Number.isSafeInteger(card.time) ||
    card.time < 1356998400000 ||
    card.time > 8640000000000000 - 8 * 3600000 ||
    !Array.isArray(card.image_list) ||
    card.image_list.length > 60 ||
    !card.image_list.every(
      (image) => typeof record(image)?.url_default === 'string',
    )
  )
    return;
  return {
    noteId: card.note_id,
    title: card.title,
    text: card.desc,
    publishedAtMs: card.time,
    declaredImageCount: card.image_list.length,
  };
}

export function formatRedbookTime(milliseconds?: number | null) {
  if (
    typeof milliseconds !== 'number' ||
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 0 ||
    milliseconds > 8640000000000000 - 8 * 3600000
  )
    return '未提供有效时间';
  return (
    new Date(milliseconds + 8 * 3600000)
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ') + '（北京时间 UTC+08:00）'
  );
}

/** Render only local inline raster previews; never turn a response URL into a request. */
export function isRedbookDiagnosticImage(image: {
  ordinal: number;
  inlineData: string;
  bytes: number;
}) {
  return (
    Number.isInteger(image.ordinal) &&
    image.ordinal > 0 &&
    Number.isInteger(image.bytes) &&
    image.bytes > 0 &&
    image.bytes <= 1000000 &&
    typeof image.inlineData === 'string' &&
    /^data:image\/(png|jpeg|gif|webp);base64,[a-zA-Z0-9+/]+={0,2}$/.test(
      image.inlineData,
    )
  );
}
