import { scheduledTaskId } from './xhs-scheduled-admission';
type Tx = {
  $queryRaw<T>(s: TemplateStringsArray, ...v: unknown[]): Promise<T>;
};
/** Manual refresh uses the same resource store while binding to its own active task. */
export async function assertManualMediaBinding(
  tx: Tx,
  input: {
    creatorId: string;
    taskId: string;
    authorId: string;
    noteId: string;
  },
) {
  const { creatorId, taskId, authorId, noteId } = input;
  const rows = await tx.$queryRaw<
    Array<{ id: string }>
  >`SELECT t.id FROM xhs_subscription_tasks t JOIN xhs_creators c ON c.id=t.creator_id JOIN xhs_source_risk r ON r.id='source' JOIN xhs_notes n ON n.id=${noteId} AND n.creator_id=t.creator_id WHERE t.id=${taskId} AND t.creator_id=${creatorId} AND t.state='running' AND c.enabled=1 AND c.external_author_id=${authorId} AND r.state='pending' AND json_extract(t.document,'$.kind')='list' AND json_extract(t.document,'$.collectDetails')=1 AND json_extract(t.document,'$.basicOnly')=1 AND json_extract(t.document,'$.reuseCompleteCache')=0 AND json_extract(t.document,'$.schedule') IS NULL AND EXISTS(SELECT 1 FROM json_each(t.document,'$.noteIds') WHERE value=${noteId}) AND EXISTS(SELECT 1 FROM json_each(t.document,'$.items') WHERE key=${noteId} AND value='completed')`;
  if (rows.length !== 1) throw Error('XHS_SCHEDULE_MEDIA_BINDING_REQUIRED');
}
/** Called inside the same transaction that marks one media resource started. */
export async function assertScheduledMediaBinding(
  tx: Tx,
  input: {
    round: string;
    creatorId: string;
    taskId: string;
    basicId: string;
    authorId: string;
    noteId: string;
    batch?: number;
  },
) {
  const { round, creatorId, taskId, basicId, authorId, noteId } = input,
    batch = input.batch ?? 0;
  if (
    taskId !== scheduledTaskId(round, creatorId, 'media', batch) ||
    basicId !== scheduledTaskId(round, creatorId, 'basic')
  )
    throw Error('XHS_SCHEDULE_MEDIA_BINDING_REQUIRED');
  const rows = await tx.$queryRaw<
    Array<{ id: string }>
  >`SELECT m.id FROM xhs_subscription_tasks m JOIN xhs_subscription_tasks b ON b.id=${basicId} AND b.creator_id=m.creator_id JOIN xhs_creators c ON c.id=m.creator_id JOIN xhs_source_risk r ON r.id='source' JOIN xhs_notes n ON n.id=${noteId} AND n.creator_id=m.creator_id WHERE m.id=${taskId} AND m.creator_id=${creatorId} AND m.state='running' AND (b.state='completed' OR (b.state='partial' AND json_extract(b.document,'$.code')='XHS_SCHEDULE_HISTORY_REVIEW_REQUIRED') OR (b.state='partial' AND json_extract(b.document,'$.code') IN ('XHS_DETAIL_PARSE_FAILED','XHS_LOCAL_PRE_DISPATCH_FAILED') AND json_extract(b.document,'$.remaining')=0 AND EXISTS (SELECT 1 FROM json_each(b.document,'$.items') WHERE key=${noteId} AND value='completed'))) AND c.enabled=1 AND c.external_author_id=${authorId} AND r.state='pending' AND json_extract(m.document,'$.schedule.round')=${round} AND json_extract(m.document,'$.schedule.phase')='media' AND COALESCE(json_extract(m.document,'$.schedule.batch'),0)=${batch} AND json_extract(b.document,'$.schedule.round')=${round} AND json_extract(b.document,'$.schedule.phase')='basic' AND EXISTS (SELECT 1 FROM json_each(b.document,'$.noteIds') WHERE value=${noteId}) AND EXISTS (SELECT 1 FROM json_each(m.document,'$.noteIds') WHERE value=${noteId})`;
  if (rows.length !== 1) throw Error('XHS_SCHEDULE_MEDIA_BINDING_REQUIRED');
}
