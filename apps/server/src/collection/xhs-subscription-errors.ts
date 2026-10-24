import { TRPCError } from '@trpc/server';
import { RedbookPauseError } from './redbook-client';
/** Public fixed codes only. Never expose provider errors, URLs, tokens or bodies. */
export class XhsSubscriptionError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const codes = new Set([
  'XHS_LIST_INVALID',
  'XHS_SELECTION_CHANGED',
  'XHS_NOTE_ID_INVALID',
  'XHS_DETAIL_INCOMPLETE',
  'XHS_SUBSCRIPTION_CHANGED',
  'XHS_SUBSCRIPTION_REQUIRED',
  'XHS_NOTE_OWNER_CONFLICT',
  'XHS_LOCAL_MEDIA_INCOMPLETE',
  'XHS_TASK_RECEIPT_UNCERTAIN',
  'XHS_TASK_SUPERSEDED',
  'XHS_SOURCE_AUTHENTICATION_BLOCKED',
  'XHS_SOURCE_VERIFICATION_BLOCKED',
  'XHS_SOURCE_PERMISSION_BLOCKED',
  'XHS_SOURCE_SIGNATURE_BLOCKED',
  'XHS_SOURCE_RATE_LIMIT_BLOCKED',
  'XHS_LIVE_ACCESS_DISABLED',
  'XHS_SESSION_REQUIRED',
  'XHS_SESSION_CHANGED',
  'XHS_SESSION_BUSY',
  'XHS_VAULT_UNAVAILABLE',
  'XHS_VAULT_OPERATION_FAILED',
  'XHS_DISCONNECT_INCOMPLETE',
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
  if (error instanceof XhsSubscriptionError && codes.has(error.code))
    return error.code;
  // Local business rejections have fixed allowlisted messages. Never forward
  // arbitrary Error.message, provider response text or signed links.
  if (error instanceof TRPCError && codes.has(error.message))
    return error.message;
  return fallback;
}
