import { RedbookClient, RedbookUserPageOptions } from './redbook-client';
import {
  mapRedbookDetail,
  mapRedbookPage,
  RedbookMediaTransport,
} from './redbook-response';
import { XhsSubscriptionSource } from './xhs-subscription.service';
import { XhsAuthor } from '@wewe-rss/shared';
import { XhsShortLinkResolver } from './xhs-short-link';
import { XhsSubscriptionError } from './xhs-subscription-errors';

const record = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new XhsSubscriptionError('XHS_PROFILE_SCHEMA_UNRECOGNIZED');
  return v as Record<string, unknown>;
};
const id = (v: unknown) => {
  if (typeof v !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(v))
    throw new XhsSubscriptionError('XHS_AUTHOR_MISMATCH');
  return v;
};
/** The public upstream returns unknown. Supply a parser only for a separately
 * reviewed profile schema; never guess basic_info or public HTML fields. */
export type XhsProfileParser = (
  raw: unknown,
  expectedAuthorId: string,
) => XhsAuthor;
const unknownProfile: XhsProfileParser = () => {
  throw new XhsSubscriptionError('XHS_PROFILE_SCHEMA_UNRECOGNIZED');
};
type Access = { token: string; source: string; expiresAt: number };
type Options = {
  profileParser?: XhsProfileParser;
  shortLinks?: XhsShortLinkResolver;
  /** Private memory lifetime, not an assertion of platform token validity. */
  contextLifetimeMs?: number;
  now?: () => number;
};
export class RedbookSubscriptionAdapter implements XhsSubscriptionSource {
  private readonly tokens = new Map<string, Access>();
  private readonly authors = new Map<string, Access>();
  private readonly now: () => number;
  private readonly lifetime: number;
  private readonly shortLinks: XhsShortLinkResolver;
  private readonly profileParser: XhsProfileParser;
  constructor(
    private readonly client: Pick<
      RedbookClient,
      'getUserInfo' | 'getUserNotes' | 'getNoteById'
    >,
    options: Options = {},
    private readonly media?: RedbookMediaTransport,
  ) {
    this.now = options.now ?? Date.now;
    this.lifetime = options.contextLifetimeMs ?? 24 * 60 * 60_000;
    if (!Number.isSafeInteger(this.lifetime) || this.lifetime <= 0)
      throw Error('XHS_CONTEXT_POLICY_INVALID');
    this.shortLinks = options.shortLinks ?? new XhsShortLinkResolver();
    this.profileParser = options.profileParser ?? unknownProfile;
  }
  private access(token: string, source: string): Access {
    if (
      token.length > 4096 ||
      source.length > 128 ||
      /[\x00-\x20\x7f]/.test(token + source)
    )
      throw new XhsSubscriptionError('XHS_ACCESS_CONTEXT_EXPIRED');
    return { token, source, expiresAt: this.now() + this.lifetime };
  }
  private options(authorId: string): RedbookUserPageOptions {
    const context = this.authors.get(authorId);
    if (!context || context.expiresAt <= this.now())
      throw new XhsSubscriptionError('XHS_ACCESS_CONTEXT_EXPIRED');
    return { xsecToken: context.token, xsecSource: context.source };
  }
  async resolve(raw: string) {
    const url = await this.shortLinks.resolve(raw);
    const inputKind = url.pathname.startsWith('/user/profile/')
      ? ('profile' as const)
      : ('note' as const);
    const token = url.searchParams.get('xsec_token') ?? '',
      source = url.searchParams.get('xsec_source') ?? '';
    let author: XhsAuthor;
    if (inputKind === 'profile') {
      const authorId = id(url.pathname.split('/').filter(Boolean).pop());
      const access = this.access(token, source);
      const rawProfile = await this.client.getUserInfo(authorId, {
        xsecToken: access.token,
        xsecSource: access.source,
      });
      try {
        author = this.profileParser(rawProfile, authorId);
      } catch (e) {
        if (e instanceof XhsSubscriptionError) throw e;
        throw new XhsSubscriptionError('XHS_PROFILE_SCHEMA_UNRECOGNIZED');
      }
      if (!author || author.id !== authorId)
        throw new XhsSubscriptionError('XHS_AUTHOR_MISMATCH');
      this.authors.set(authorId, access);
    } else {
      const noteId = id(url.pathname.split('/').filter(Boolean).pop());
      if (!token) throw new XhsSubscriptionError('XHS_NOTE_TOKEN_REQUIRED');
      const access = this.access(token, source || 'pc_share');
      const rawDetail = record(
        await this.client.getNoteById(noteId, access.token, access.source),
      );
      if (!Array.isArray(rawDetail.items) || rawDetail.items.length !== 1)
        throw new XhsSubscriptionError('XHS_AUTHOR_MISMATCH');
      const item = record(rawDetail.items[0]),
        card = record(item.note_card),
        user = record(card.user);
      if (item.id !== noteId || card.note_id !== noteId)
        throw new XhsSubscriptionError('XHS_AUTHOR_MISMATCH');
      const authorId = id(user.user_id);
      if (
        typeof user.nickname !== 'string' ||
        !user.nickname.trim() ||
        user.nickname.length > 120
      )
        throw new XhsSubscriptionError('XHS_AUTHOR_NAME_MISSING');
      author = {
        id: authorId,
        name: user.nickname.trim(),
        profileUrl: `https://www.xiaohongshu.com/user/profile/${authorId}`,
      };
      this.tokens.set(JSON.stringify([authorId, noteId]), access);
      // A note token never becomes an author-profile token.
      if (!this.authors.has(authorId))
        this.authors.set(authorId, this.access('', ''));
    }
    if (
      !author.name?.trim() ||
      author.name.length > 120 ||
      author.profileUrl !==
        `https://www.xiaohongshu.com/user/profile/${author.id}`
    )
      throw new XhsSubscriptionError('XHS_PROFILE_SCHEMA_UNRECOGNIZED');
    return { inputKind, author };
  }
  async list(authorId: string, cursor: string | null, signal?: AbortSignal) {
    const raw = record(
      await this.client.getUserNotes(authorId, cursor ?? '', {
        ...this.options(authorId),
        ...(signal ? { signal } : {}),
      }),
    );
    const page = mapRedbookPage(raw, authorId);
    for (const [key, access] of this.tokens)
      if (access.expiresAt <= this.now()) this.tokens.delete(key);
    // No arbitrary all-entry eviction: earlier pages remain usable for large jobs.
    const notes = page.notes.map((n, i) => {
      this.tokens.set(
        JSON.stringify([authorId, n.noteId]),
        this.access(n.xsecToken, 'pc_user'),
      );
      const source = record((raw.notes as unknown[])[i]);
      const card =
        source.note_card === undefined ? source : record(source.note_card);
      const title =
        typeof card.display_title === 'string'
          ? card.display_title
          : typeof card.title === 'string'
            ? card.title
            : '';
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
  async detail(authorId: string, noteId: string, signal?: AbortSignal) {
    const access = this.tokens.get(JSON.stringify([authorId, noteId]));
    if (!access || access.expiresAt <= this.now())
      throw new XhsSubscriptionError('XHS_ACCESS_CONTEXT_EXPIRED');
    const media =
      this.media &&
      ((url: URL, options: Parameters<RedbookMediaTransport>[1]) =>
        this.media!(url, {
          ...options,
          signal: signal
            ? AbortSignal.any([signal, options.signal])
            : options.signal,
        }));
    return mapRedbookDetail(
      await this.client.getNoteById(
        noteId,
        access.token,
        access.source,
        signal,
      ),
      authorId,
      noteId,
      media,
    );
  }
}
