import { z } from 'zod';
import { articleFilterShape, orderedArticleDates } from './article-date-filter';

export const xhsNoteFilterSchema = z
  .object({
    creatorId: z.string().min(1).max(128),
    search: articleFilterShape.search,
    dateStart: articleFilterShape.dateStart,
    dateEnd: articleFilterShape.dateEnd,
  })
  .strict()
  .refine(orderedArticleDates);
export type XhsNoteFilter = z.infer<typeof xhsNoteFilterSchema>;
export type XhsAuthor = {
  id: string;
  name: string;
  profileUrl: string;
  avatarUrl?: string;
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
  code?: string;
  message: string;
};
