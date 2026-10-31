import type { XhsMetricSnapshot, XhsSavedComment } from '@wewe-rss/shared';

export const XHS_ENGAGEMENT_CONTRACT =
  'redbook-main-declares-0.8.2/source-only/v1';
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
export type XhsFieldDiagnostic = {
  field: 'collected_count' | 'share_count';
  present: boolean | null;
  type: string;
  result: 'parsed' | 'absent' | 'absent-container' | 'invalid-container' | 'null' | 'invalid-format' | 'invalid-type';
  parsed: number | null;
  persistence?: 'stored' | 'missing' | 'mismatch' | 'not-parsed';
};
export type XhsDiagnosedMetrics = XhsMetricSnapshot & {
  fieldDiagnostics?: Partial<Record<'collects' | 'shares', XhsFieldDiagnostic>>;
  valueCollectedAt?: Record<string, number>;
};
function fieldDiagnostic(info: Record<string, unknown>, field: 'collected_count' | 'share_count', container: 'object' | 'absent' | 'invalid'): XhsFieldDiagnostic {
  if (container !== 'object') return { field, present: null, type: 'unavailable', result: container === 'absent' ? 'absent-container' : 'invalid-container', parsed: null };
  const present = Object.prototype.hasOwnProperty.call(info, field), value = info[field];
  const type = !present ? 'absent' : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const parsed = xhsExactCount(value);
  const result = parsed !== null ? 'parsed' : !present ? 'absent' : value === null ? 'null' : typeof value === 'string' || typeof value === 'number' ? 'invalid-format' : 'invalid-type';
  return { field, present, type, result, parsed };
}
/** Exact integers only. Abbreviated/rounded display counts remain unknown. */
export function xhsExactCount(v: unknown): number | null {
  if (typeof v === 'string' && /^(0|[1-9]\d{0,15})$/.test(v)) v = Number(v);
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
}
export function xhsNoteMetrics(
  card: unknown,
  at = Date.now(),
): XhsDiagnosedMetrics {
  const raw = object(card), rawInfo = raw.interact_info;
  const container = !Object.prototype.hasOwnProperty.call(raw, 'interact_info') ? 'absent' : rawInfo && typeof rawInfo === 'object' && !Array.isArray(rawInfo) ? 'object' : 'invalid';
  const info = object(rawInfo);
  return {
    values: {
      likes: xhsExactCount(info.liked_count),
      collects: xhsExactCount(info.collected_count),
      shares: xhsExactCount(info.share_count),
      comments: xhsExactCount(info.comment_count),
    },
    fieldDiagnostics: { collects: fieldDiagnostic(info, 'collected_count', container), shares: fieldDiagnostic(info, 'share_count', container) },
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
