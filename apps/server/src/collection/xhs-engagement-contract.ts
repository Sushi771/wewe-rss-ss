import type { XhsMetricSnapshot, XhsSavedComment } from '@wewe-rss/shared';

export const XHS_ENGAGEMENT_CONTRACT =
  'redbook-main-declares-0.8.2/source-only/v1';
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
/** Exact integers only. Abbreviated/rounded display counts remain unknown. */
export function xhsExactCount(v: unknown): number | null {
  if (typeof v === 'string' && /^(0|[1-9]\d{0,15})$/.test(v)) v = Number(v);
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
}
export function xhsNoteMetrics(
  card: unknown,
  at = Date.now(),
): XhsMetricSnapshot {
  const info = object(object(card).interact_info);
  return {
    values: {
      likes: xhsExactCount(info.liked_count),
      collects: xhsExactCount(info.collected_count),
      shares: xhsExactCount(info.share_count),
      comments: xhsExactCount(info.comment_count),
    },
    collectedAt: at,
    contract: XHS_ENGAGEMENT_CONTRACT,
    evidence: 'source-only',
  };
}
export function xhsProfileMetrics(
  raw: unknown,
  at = Date.now(),
): XhsMetricSnapshot {
  const entries = object(raw).interactions;
  const fans = Array.isArray(entries)
    ? entries.filter((e) => object(e).type === 'fans')
    : [];
  return {
    values: {
      fans: fans.length === 1 ? xhsExactCount(object(fans[0]).count) : null,
      // No reviewed following-count response contract yet. Never guess follows/following.
      following: null,
    },
    collectedAt: at,
    contract: XHS_ENGAGEMENT_CONTRACT,
    evidence: 'source-only',
  };
}
const text = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.length <= max ? v : null;
const id = (v: unknown): string => {
  if (typeof v !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(v))
    throw Error('XHS_COMMENT_ID_UNVERIFIED');
  return v;
};
/** Provisional strict seam, tested synthetically only. id, create_time and
 * sub_comments are NOT claimed as observed live contracts. Unknown shape stops
 * without advancing the cursor. Root linkage comes from the requested scope;
 * parentId remains null until an explicit reply-target schema is reviewed. */
export function mapXhsComments(
  raw: unknown,
  rootId: string | null = null,
  at = Date.now(),
) {
  const page = object(raw);
  if (
    !Array.isArray(page.comments) ||
    page.comments.length > 200 ||
    typeof page.has_more !== 'boolean'
  )
    throw Error('XHS_COMMENT_SCHEMA_UNVERIFIED');
  const cursor = text(page.cursor, 2048);
  if (page.has_more && !cursor) throw Error('XHS_COMMENT_CURSOR_INVALID');
  const result: XhsSavedComment[] = [];
  const parse = (v: unknown, root: string | null) => {
    const c = object(v),
      user = object(c.user_info),
      commentId = id(c.id);
    if (root === commentId) throw Error('XHS_COMMENT_RELATION_INVALID');
    const content = text(c.content, 100000);
    if (content === null) throw Error('XHS_COMMENT_SCHEMA_UNVERIFIED');
    // Timestamp and exact reply target need real evidence: keep unknown rather
    // than guessing epoch units or target structures from a field name.
    result.push({
      id: commentId,
      rootId: root,
      parentId: null,
      content,
      authorId: text(user.user_id, 128),
      authorName: text(user.nickname, 120),
      likes: xhsExactCount(c.like_count),
      publishedAt: null,
      collectedAt: at,
    });
    return commentId;
  };
  for (const v of page.comments) {
    const commentId = parse(v, rootId),
      c = object(v);
    if (c.sub_comments !== undefined) {
      if (
        rootId ||
        !Array.isArray(c.sub_comments) ||
        c.sub_comments.length > 100
      )
        throw Error('XHS_COMMENT_SCHEMA_UNVERIFIED');
      for (const child of c.sub_comments) parse(child, commentId);
    }
  }
  if (
    result.length > 200 ||
    Buffer.byteLength(JSON.stringify(result)) > 1_500_000
  )
    throw Error('XHS_COMMENT_PAGE_LIMIT');
  const identities = new Map<string, string | null>();
  for (const c of result) {
    if (identities.has(c.id) && identities.get(c.id) !== c.rootId)
      throw Error('XHS_COMMENT_RELATION_INVALID');
    identities.set(c.id, c.rootId);
  }
  return { comments: result, nextCursor: page.has_more ? cursor! : null };
}
