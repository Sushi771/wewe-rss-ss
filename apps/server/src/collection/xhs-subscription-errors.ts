import { RedbookPauseError } from './redbook-client';
/** Public fixed codes only. Never expose provider errors, URLs, tokens or bodies. */
export class XhsSubscriptionError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const codes = new Set([
  'XHS_PROFILE_SCHEMA_UNRECOGNIZED',
  'XHS_AUTHOR_MISMATCH',
  'XHS_AUTHOR_NAME_MISSING',
  'XHS_NOTE_TOKEN_REQUIRED',
  'XHS_ACCESS_CONTEXT_EXPIRED',
  'XHS_SHORT_LINK_UNAVAILABLE',
  'XHS_SHORT_LINK_REJECTED',
  'XHS_CURSOR_CYCLE',
  'XHS_LIST_NO_PROGRESS',
]);
export function xhsPublicCode(error: unknown, fallback: string) {
  if (
    error instanceof RedbookPauseError &&
    [
      'configuration',
      'authentication',
      'verification',
      'permission',
      'signature',
      'rate_limit',
      'transport',
      'response',
    ].includes(error.reason)
  )
    return `XHS_SOURCE_${error.reason.toUpperCase()}_BLOCKED`;
  return error instanceof XhsSubscriptionError && codes.has(error.code)
    ? error.code
    : fallback;
}
