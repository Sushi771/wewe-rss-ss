import { z } from 'zod';

export const xhsMetricNames = [
  'likes',
  'collects',
  'shares',
  'comments',
] as const;
export const xhsCreatorMetricNames = ['fans', 'following'] as const;
export type XhsMetric = (typeof xhsMetricNames)[number];
export type XhsCreatorMetric = (typeof xhsCreatorMetricNames)[number];
export type XhsMetricSnapshot = {
  values: Record<string, number | null>;
  collectedAt: number;
  contract: string;
  evidence: 'source-only' | 'verified-response';
};
export const xhsNumericFilterShape = {
  metric: z.enum(xhsMetricNames).optional(),
  min: z.number().int().nonnegative().safe().optional(),
  max: z.number().int().nonnegative().safe().optional(),
  metricDirection: z.enum(['asc', 'desc']).optional(),
  offset: z.number().int().nonnegative().max(1000000).optional(),
  limit: z.number().int().min(1).max(500).optional(),
};
export const xhsCreatorFilterSchema = z
  .object({
    groupId: z.string().min(1).max(128).nullable().optional(),
    metric: z.enum(xhsCreatorMetricNames).optional(),
    min: xhsNumericFilterShape.min,
    max: xhsNumericFilterShape.max,
    metricDirection: xhsNumericFilterShape.metricDirection,
  })
  .strict()
  .refine(xhsNumericRange);
export function xhsNumericRange(v: {
  metric?: string;
  min?: number;
  max?: number;
}) {
  return (
    ((v.min === undefined && v.max === undefined) || !!v.metric) &&
    (v.min === undefined || v.max === undefined || v.min <= v.max)
  );
}
export type XhsCreatorFilter = z.infer<typeof xhsCreatorFilterSchema>;
export type XhsSavedComment = {
  id: string;
  rootId: string | null;
  parentId: string | null;
  content: string;
  authorId: string | null;
  authorName: string | null;
  likes: number | null;
  publishedAt: number | null;
  collectedAt: number;
};
export type XhsCommentWindow = {
  scope: string;
  nextCursor: string | null;
  pages: number;
  state: 'partial' | 'returned-end' | 'failed';
  code: string | null;
  collectedAt: number;
};
export type XhsEngagementView = {
  metrics: XhsMetricSnapshot | null;
  creatorMetrics: XhsMetricSnapshot | null;
  comments: XhsSavedComment[];
  windows: XhsCommentWindow[];
  totalSaved: number;
  returned: number;
  offset: number;
};

/** Used after a server-wide selection; nulls always last, IDs break ties. */
export function xhsMetricSelection<
  T extends { id: string; metrics: XhsMetricSnapshot | null },
>(
  rows: T[],
  input?: {
    metric?: string;
    min?: number;
    max?: number;
    metricDirection?: 'asc' | 'desc';
  },
): T[] {
  if (!input?.metric) return rows;
  const metric = input.metric;
  return rows
    .filter((row) => {
      const n = row.metrics?.values[metric] ?? null;
      return (
        (input.min === undefined && input.max === undefined) ||
        (n !== null &&
          (input.min === undefined || n >= input.min) &&
          (input.max === undefined || n <= input.max))
      );
    })
    .sort((a, b) => {
      const av = a.metrics?.values[metric] ?? null,
        bv = b.metrics?.values[metric] ?? null;
      if (av === null || bv === null)
        return av === bv ? a.id.localeCompare(b.id) : av === null ? 1 : -1;
      return (
        (input.metricDirection === 'asc' ? av - bv : bv - av) ||
        a.id.localeCompare(b.id)
      );
    });
}
