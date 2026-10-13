import { z } from 'zod';

/** Calendar dates are interpreted in Asia/Shanghai, independent of host timezone. */
export function shanghaiDayStart(date: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < '1970-01-01') return;
  const utc = Date.parse(`${date}T00:00:00Z`);
  if (
    !Number.isFinite(utc) ||
    new Date(utc).toISOString().slice(0, 10) !== date
  )
    return;
  return utc / 1000 - 8 * 3600;
}

const calendarDate = z
  .string()
  .refine((date) => shanghaiDayStart(date) !== undefined, {
    message: '请输入有效日期（YYYY-MM-DD）',
  });

export const articleFilterShape = {
  mpId: z.string().nullish(),
  search: z.string().nullish(),
  group: z.string().min(1).optional(),
  dateStart: calendarDate.optional(),
  dateEnd: calendarDate.optional(),
};

export function orderedArticleDates(input: {
  dateStart?: string;
  dateEnd?: string;
}) {
  return !input.dateStart || !input.dateEnd || input.dateStart <= input.dateEnd;
}

export const articleFilterSchema = z
  .object(articleFilterShape)
  .refine(orderedArticleDates, {
    message: '结束日期不能早于开始日期',
    path: ['dateEnd'],
  });

export type ArticleFilter = z.infer<typeof articleFilterSchema>;

export function articlePublicationRange(input: ArticleFilter) {
  if (!input.dateStart && !input.dateEnd) return undefined;
  return {
    // Unknown dates (zero) stay unknown and never become today's articles.
    gt: 0,
    ...(input.dateStart ? { gte: shanghaiDayStart(input.dateStart)! } : {}),
    ...(input.dateEnd ? { lt: shanghaiDayStart(input.dateEnd)! + 86400 } : {}),
  };
}

export function formatShanghaiPublicationTime(seconds: number) {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return '发布时间未知';
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(seconds * 1000));
}
