import { z } from 'zod';
import { articleFilterShape, orderedArticleDates } from './article-date-filter';
import {
  xhsNumericFilterShape,
  xhsNumericRange,
  XhsMetricSnapshot,
} from './xhs-engagement';

export const xhsNoteFilterSchema = z
  .object({
    ...xhsNumericFilterShape,
    creatorId: z.string().min(1).max(128).optional(),
    groupId: z.string().min(1).max(128).nullable().optional(),
    search: articleFilterShape.search,
    dateStart: articleFilterShape.dateStart,
    dateEnd: articleFilterShape.dateEnd,
  })
  .strict()
  .refine(orderedArticleDates)
  .refine(xhsNumericRange);
export type XhsNoteFilter = z.infer<typeof xhsNoteFilterSchema>;
export type XhsAuthor = {
  id: string;
  name: string;
  profileUrl: string;
  avatarUrl?: string;
  metrics?: XhsMetricSnapshot;
};
export type XhsSubscriptionResolution = {
  resolutionId: string;
  inputKind: 'note' | 'profile';
  author: XhsAuthor;
  existingCreatorId: string | null;
  expiresAt: number;
};
export type XhsSubscriptionTask = {
  taskId: string;
  creatorId: string;
  kind: 'list' | 'download';
  state:
    | 'queued'
    | 'running'
    | 'completed'
    | 'partial'
    | 'blocked'
    | 'cancelled'
    | 'failed';
  total: number;
  completed: number;
  skipped: number;
  failed: number;
  remaining: number;
  snapshotsSaved?: number;
  code?: string;
  message: string;
  resumable?: boolean;
  resumedFromTaskId?: string;
  supersededByTaskId?: string;
};
export type XhsConnectionStatus = {
  requestAttempts?: {
    instanceId: string;
    profiles: number;
    lists: number;
    details: number;
    media: number;
    shortLinks: number;
    comments?: number;
    replies?: number;
  };
  liveEnabled: boolean;
  connected: boolean;
  stored: boolean | null;
  verified: boolean;
  canConnect: boolean;
  canPersist: boolean;
  restartRequiresReparse: true;
  code?: string;
  message: string;
};

export const xhsOriginalLinkCodes = [
  'XHS_ORIGINAL_LINK_SOURCE_UNAVAILABLE',
  'XHS_ORIGINAL_LINK_CONTEXT_UNAVAILABLE',
  'XHS_ORIGINAL_LINK_NOT_READY',
  'XHS_NOTE_ID_INVALID',
  'XHS_SUBSCRIPTION_REQUIRED',
  'XHS_BUDGET_SCOPE_MISMATCH',
  'XHS_REQUEST_BUDGET_REQUIRED',
  'XHS_REQUEST_BUDGET_EXHAUSTED',
  'XHS_REQUEST_RATE_PAUSED',
  'XHS_LIVE_ACCESS_DISABLED',
  'XHS_SESSION_REQUIRED',
  'XHS_SESSION_CHANGED',
  'XHS_PROFILE_SCHEMA_UNRECOGNIZED',
  'XHS_AUTHOR_MISMATCH',
  'XHS_ACCESS_CONTEXT_EXPIRED',
  'XHS_ACCESS_CONTEXT_UNAVAILABLE',
  'XHS_CURSOR_CYCLE',
  'XHS_SOURCE_CONFIGURATION_BLOCKED',
  'XHS_SOURCE_AUTHENTICATION_BLOCKED',
  'XHS_SOURCE_VERIFICATION_BLOCKED',
  'XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED',
  'XHS_SOURCE_PERMISSION_BLOCKED',
  'XHS_SOURCE_SIGNATURE_BLOCKED',
  'XHS_SOURCE_RATE_LIMIT_BLOCKED',
  'XHS_SOURCE_TRANSPORT_BLOCKED',
  'XHS_SOURCE_RESPONSE_BLOCKED',
] as const;
export type XhsOriginalLinkCode = (typeof xhsOriginalLinkCodes)[number];
/** Transient explicit-navigation result; never store a ready URL in note rows. */
export type XhsOriginalLinkResult =
  | { state: 'ready'; url: string }
  | { state: 'not_ready'; code: XhsOriginalLinkCode };
export type XhsSourceBudgetScope =
  | { purpose: 'resolution' }
  | { purpose: 'original-link'; creatorId: string };
export type XhsSourceBudgetView = {
  budgetId: string;
  limit: number;
  used: number;
  remaining: number;
  nextAt: number;
  intervalMs: number;
  scopeUsed?: number;
};
