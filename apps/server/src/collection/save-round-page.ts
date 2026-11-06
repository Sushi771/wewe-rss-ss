import type { RoundTx } from './xhs-unbound-round';

/** Exact existing list persistence semantics: preserve existing body, metadata and IDs. */
export async function saveRoundPage(
  tx: RoundTx,
  creatorId: string,
  authorId: string,
  page: any,
) {
  if (
    page?.authorId !== authorId ||
    !Array.isArray(page.notes) ||
    page.notes.length > 30
  )
    throw Error('XHS_LIST_INVALID');
  const creators = await tx.$queryRawUnsafe<any[]>(
    'SELECT external_author_id,enabled FROM xhs_creators WHERE id=?',
    creatorId,
  );
  if (
    creators.length !== 1 ||
    Number(creators[0].enabled) !== 1 ||
    creators[0].external_author_id !== authorId
  )
    throw Error('XHS_SUBSCRIPTION_CHANGED');
  let added = 0,
    skipped = 0;
  const seen = new Set<string>();
  for (const n of page.notes) {
    if (
      n.authorId !== authorId ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(n.noteId) ||
      typeof n.title !== 'string' ||
      n.title.length > 500 ||
      !Number.isSafeInteger(n.publishedAt) ||
      n.publishedAt < 0 ||
      n.publishedAt > 2147483647 ||
      !['image-text', 'video'].includes(n.kind)
    )
      throw Error('XHS_LIST_INVALID');
    const id = JSON.stringify(['xiaohongshu', 'note', n.noteId]);
    if (seen.has(id)) continue;
    seen.add(id);
    const old = await tx.$queryRawUnsafe<any[]>(
      'SELECT creator_id FROM xhs_notes WHERE id=?',
      id,
    );
    if (old.length) {
      if (old[0].creator_id !== creatorId)
        throw Error('XHS_NOTE_OWNER_CONFLICT');
      skipped++;
      continue;
    }
    added += await tx.$executeRawUnsafe(
      'INSERT INTO xhs_notes(id,creator_id,title,publish_time,status,kind) VALUES(?,?,?,?,?,?)',
      id,
      creatorId,
      n.title,
      n.publishedAt,
      n.kind === 'video' ? 'video-skipped' : 'listed',
      n.kind,
    );
  }
  return {
    creatorId,
    listed: seen.size,
    added,
    skipped,
    pages: 1,
    nextPageRequested: false,
  };
}
