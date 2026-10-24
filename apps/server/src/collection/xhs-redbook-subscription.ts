import { RedbookClient } from './redbook-client';
import {
  mapRedbookDetail,
  mapRedbookPage,
  RedbookMediaTransport,
} from './redbook-response';
import {
  subscriptionUrl,
  XhsSubscriptionSource,
} from './xhs-subscription.service';
import { XhsAuthor } from '@wewe-rss/shared';

const record = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new Error('XHS_SCHEMA_INVALID');
  return v as Record<string, unknown>;
};
const id = (v: unknown) => {
  if (typeof v !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(v))
    throw new Error('XHS_ID_INVALID');
  return v;
};
/** getUserInfo is not present in the reviewed client. The host must provide an
 * independently verified public-profile reader; never fabricate names from IDs
 * or guess a profile response schema. This also resolves empty-note creators. */
export type XhsProfileReader = (authorId: string) => Promise<XhsAuthor>;
export class RedbookSubscriptionAdapter implements XhsSubscriptionSource {
  private tokens = new Map<string, { token: string; expiresAt: number }>();
  constructor(
    private readonly client: Pick<
      RedbookClient,
      'getUserNotes' | 'getNoteById'
    >,
    private readonly profile: XhsProfileReader,
    private readonly media?: RedbookMediaTransport,
  ) {}
  async resolve(raw: string) {
    const url = new URL(subscriptionUrl(raw));
    const inputKind = url.pathname.startsWith('/user/profile/')
      ? ('profile' as const)
      : ('note' as const);
    let authorId: string;
    if (inputKind === 'profile')
      authorId = id(url.pathname.split('/').filter(Boolean).pop());
    else {
      const noteId = id(url.pathname.split('/').pop()),
        token = url.searchParams.get('xsec_token');
      if (!token) throw new Error('XHS_NOTE_TOKEN_REQUIRED');
      const rawDetail = record(await this.client.getNoteById(noteId, token));
      if (!Array.isArray(rawDetail.items) || rawDetail.items.length !== 1)
        throw new Error('XHS_NOTE_INVALID');
      const item = record(rawDetail.items[0]),
        card = record(item.note_card);
      if (item.id !== noteId || card.note_id !== noteId)
        throw new Error('XHS_NOTE_MISMATCH');
      authorId = id(record(card.user).user_id);
    }
    const author = await this.profile(authorId);
    if (author.id !== authorId) throw new Error('XHS_AUTHOR_MISMATCH');
    return { inputKind, author };
  }
  async list(authorId: string, cursor: string | null) {
    const raw = record(await this.client.getUserNotes(authorId, cursor ?? ''));
    const page = mapRedbookPage(raw, authorId);
    const now = Date.now();
    for (const [key, value] of this.tokens)
      if (value.expiresAt <= now) this.tokens.delete(key);
    // Bound memory and keep request secrets out of SQLite, task API and logs.
    if (this.tokens.size + page.notes.length > 3000) this.tokens.clear();
    const notes = page.notes.map((n, i) => {
      this.tokens.set(JSON.stringify([authorId, n.noteId]), {
        token: n.xsecToken,
        expiresAt: now + 15 * 60_000,
      });
      const source = record((raw.notes as unknown[])[i]);
      const card =
        source.note_card === undefined ? source : record(source.note_card);
      const title =
        typeof card.display_title === 'string'
          ? card.display_title
          : typeof card.title === 'string'
            ? card.title
            : '';
      // Lists do not establish publication time; zero remains unknown. Only a
      // validated detail may establish the original timestamp.
      return {
        authorId,
        noteId: n.noteId,
        title,
        publishedAt: 0,
        kind:
          card.type === 'video' ? ('video' as const) : ('image-text' as const),
      };
    });
    return { authorId, notes, nextCursor: page.nextCursor };
  }
  async detail(authorId: string, noteId: string) {
    const access = this.tokens.get(JSON.stringify([authorId, noteId]));
    if (!access || access.expiresAt <= Date.now())
      throw new Error('XHS_LIST_TOKEN_EXPIRED');
    return mapRedbookDetail(
      await this.client.getNoteById(noteId, access.token),
      authorId,
      noteId,
      this.media,
    );
  }
}
