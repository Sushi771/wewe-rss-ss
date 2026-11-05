/** Bounded error projection only: never return provider text, URLs or data.
 * Exact phrases are evidence of what the API says, not a browser challenge.
 * Unknown codes and prose stay unknown; no substring/keyword inference.
 */
const CODES = new Set([-100, -101, -104, 300012, 300015]);
const VERIFICATION_MESSAGES = new Set([
  '需要验证码',
  '请完成验证码验证',
  'captcha required',
]);
export const REDBOOK_ERROR_MAX_BYTES = 8192;
export function redbookErrorSummary(body: unknown): {
  code?: number;
  msg?: 'captcha required';
} {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  const value = body as Record<string, unknown>;
  const result: { code?: number; msg?: 'captcha required' } = {};
  if (typeof value.code === 'number' && CODES.has(value.code))
    result.code = value.code;
  if (
    [value.msg, value.message].some(
      (text) =>
        typeof text === 'string' &&
        text.length <= 64 &&
        VERIFICATION_MESSAGES.has(text),
    )
  )
    result.msg = 'captcha required';
  return result;
}
