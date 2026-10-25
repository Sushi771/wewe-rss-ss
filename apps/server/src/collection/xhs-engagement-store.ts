import { Prisma } from '@prisma/client';
import type {
  XhsMetricSnapshot,
  XhsSavedComment,
  XhsCommentWindow,
} from '@wewe-rss/shared';

type Db = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;
export async function saveXhsMetrics(
  db: Db,
  kind: 'note' | 'creator',
  owner: string,
  snapshot?: XhsMetricSnapshot,
) {
  if (!snapshot) return;
  await db.$executeRaw`INSERT INTO xhs_metric_snapshots(owner_kind,owner_id,document)
    VALUES(${kind},${owner},${JSON.stringify(snapshot)})
    ON CONFLICT(owner_kind,owner_id) DO UPDATE SET document=excluded.document
    WHERE json_extract(excluded.document,'$.collectedAt') >= json_extract(xhs_metric_snapshots.document,'$.collectedAt')`;
}
export async function readXhsMetrics(db: Db, kind: 'note' | 'creator') {
  const rows = await db.$queryRaw<
    Array<{ owner_id: string; document: string }>
  >`
    SELECT owner_id,document FROM xhs_metric_snapshots WHERE owner_kind=${kind}`;
  return new Map(
    rows.map((r) => [r.owner_id, JSON.parse(r.document) as XhsMetricSnapshot]),
  );
}
export type PrivateCommentWindow = XhsCommentWindow & { cursors: string[] };
export async function readCommentWindow(
  db: Db,
  note: string,
  scope: string,
): Promise<PrivateCommentWindow> {
  const rows = await db.$queryRaw<Array<{ document: string }>>`
    SELECT document FROM xhs_comment_windows WHERE note_id=${note} AND scope=${scope}`;
  return rows.length
    ? JSON.parse(rows[0].document)
    : {
        scope,
        nextCursor: '',
        pages: 0,
        state: 'partial',
        code: null,
        collectedAt: 0,
        cursors: [],
      };
}
export async function saveCommentWindow(
  db: Db,
  note: string,
  window: PrivateCommentWindow,
) {
  await db.$executeRaw`INSERT INTO xhs_comment_windows(note_id,scope,document)
    VALUES(${note},${window.scope},${JSON.stringify(window)})
    ON CONFLICT(note_id,scope) DO UPDATE SET document=excluded.document`;
}
export async function saveCommentPage(
  db: Db,
  note: string,
  comments: XhsSavedComment[],
  window: PrivateCommentWindow,
) {
  for (const c of comments) {
    const old = await db.$queryRaw<Array<{ root_id: string | null }>>`
      SELECT root_id FROM xhs_saved_comments WHERE note_id=${note} AND comment_id=${c.id}`;
    if (old.length && old[0].root_id !== c.rootId)
      throw Error('XHS_COMMENT_RELATION_CONFLICT');
    await db.$executeRaw`INSERT INTO xhs_saved_comments(note_id,comment_id,root_id,parent_id,document)
      VALUES(${note},${c.id},${c.rootId},${c.parentId},${JSON.stringify(c)})
      ON CONFLICT(note_id,comment_id) DO UPDATE SET document=excluded.document
      WHERE json_extract(excluded.document,'$.collectedAt') >= json_extract(xhs_saved_comments.document,'$.collectedAt')`;
  }
  await saveCommentWindow(db, note, window);
}
export async function readXhsComments(
  db: Db,
  note: string,
  offset = 0,
  limit = 200,
) {
  const [rows, counts, windows] = await Promise.all([
    db.$queryRaw<
      Array<{ document: string }>
    >`SELECT document FROM xhs_saved_comments
      WHERE note_id=${note} ORDER BY COALESCE(root_id,comment_id),root_id IS NOT NULL,comment_id LIMIT ${limit} OFFSET ${offset}`,
    db.$queryRaw<
      Array<{ n: bigint }>
    >`SELECT count(*) AS n FROM xhs_saved_comments WHERE note_id=${note}`,
    db.$queryRaw<
      Array<{ document: string }>
    >`SELECT document FROM xhs_comment_windows WHERE note_id=${note} ORDER BY scope`,
  ]);
  return {
    comments: rows.map((r) => JSON.parse(r.document) as XhsSavedComment),
    windows: windows.map((r) => {
      const { cursors: _private, ...view } = JSON.parse(
        r.document,
      ) as PrivateCommentWindow;
      void _private;
      return view;
    }),
    totalSaved: Number(counts[0].n),
    returned: rows.length,
    offset,
  };
}
