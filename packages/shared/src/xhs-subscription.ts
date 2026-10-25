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
