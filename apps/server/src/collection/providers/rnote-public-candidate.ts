import {
  RnoteCandidateResponse,
  RnotePublicClient,
  RnoteReadError,
  rnoteObject,
} from './rnote-public-client';

/** Execute the documented request and inspect only documented structure. These
 * candidates deliberately cannot implement XhsSource/XhsSingleSource's verified
 * body contract until product, identity/time and complete media are established.
 */
export class RnotePublicCandidate {
  constructor(private readonly client: RnotePublicClient) {}
  async creator(userId: string, cursor = '', num = 3) {
    const result = await this.client.posted(userId, cursor, num);
    const payload = this.inner(result);
    if (
      !rnoteObject(payload) ||
      !Array.isArray(payload.notes) ||
      typeof payload.has_more !== 'boolean' ||
      Array.from(payload.notes).some(
        (note) =>
          !rnoteObject(note) ||
          typeof note.id !== 'string' ||
          !/^[a-f0-9]{24}$/.test(note.id),
      )
    )
      throw new RnoteReadError('RNOTE_LIST_SHAPE_UNVERIFIED');
    // The public description does not establish the cursor field path. Return
    // the raw fields without guessing, silently terminating, or fetching page 2.
    return {
      requestedUserId: userId,
      requestCursor: cursor,
      ...result,
      noteIds: payload.notes.map(
        (note) => (note as Record<string, unknown>).id as string,
      ),
      hasMore: payload.has_more,
      cursorMappingVerified: false as const,
    };
  }
  async note(noteId: string, kind: 'image' | 'video') {
    if (!['image', 'video'].includes(kind))
      throw new RnoteReadError('RNOTE_PARAMETER_INVALID');
    const result = await (kind === 'image'
      ? this.client.image(noteId)
      : this.client.video(noteId));
    const payload = this.inner(result);
    if (
      !Array.isArray(payload) ||
      !payload.length ||
      Array.from(payload).some((note) => !rnoteObject(note))
    )
      throw new RnoteReadError('RNOTE_DETAIL_SHAPE_UNVERIFIED');
    return {
      requestedNoteId: noteId,
      requestedKind: kind,
      ...result,
      identityMappingVerified: false as const,
      wholeBodyVerified: false as const,
      mediaBytesVerified: false as const,
    };
  }
  async pgyNote(noteId: string) {
    const result = await this.client.pgyDetail(noteId);
    const payload = this.inner(result);
    if (
      !rnoteObject(payload) ||
      payload.noteId !== noteId ||
      typeof payload.userId !== 'string' ||
      !/^[a-f0-9]{24}$/.test(payload.userId) ||
      typeof payload.title !== 'string' ||
      typeof payload.content !== 'string' ||
      !Object.prototype.hasOwnProperty.call(payload, 'createTime')
    )
      throw new RnoteReadError('RNOTE_DETAIL_SHAPE_UNVERIFIED');
    return {
      requestedNoteId: noteId,
      ...result,
      publicationUnitVerified: false as const,
      wholeBodyVerified: false as const,
      mediaBytesVerified: false as const,
    };
  }
  async pgyCreator(
    userId: string,
    page = 1,
    size = 3,
    variant: 'notes' | 'notes_v2' = 'notes',
  ) {
    const result = await this.client.pgyNotes(userId, page, size, variant);
    const payload = this.inner(result);
    const entries = rnoteObject(payload)
      ? payload[variant === 'notes' ? 'list' : 'noteList']
      : undefined;
    if (
      !rnoteObject(payload) ||
      !Array.isArray(entries) ||
      !Number.isSafeInteger(payload.total) ||
      (payload.total as number) < 0
    )
      throw new RnoteReadError('RNOTE_LIST_SHAPE_UNVERIFIED');
    const noteIds = Array.from(entries, (entry) => {
      const note =
        variant === 'notes'
          ? entry
          : rnoteObject(entry)
            ? entry.noteInfo
            : undefined;
      if (
        !rnoteObject(note) ||
        typeof note.noteId !== 'string' ||
        !/^[a-f0-9]{24}$/.test(note.noteId)
      )
        throw new RnoteReadError('RNOTE_LIST_SHAPE_UNVERIFIED');
      return note.noteId;
    });
    return {
      requestedUserId: userId,
      requestPage: page,
      variant,
      ...result,
      noteIds,
      total: payload.total as number,
      publicationUnitVerified: false as const,
    };
  }
  private inner(result: RnoteCandidateResponse): unknown {
    if (!Object.prototype.hasOwnProperty.call(result.data, 'data'))
      throw new RnoteReadError('RNOTE_PAYLOAD_UNVERIFIED');
    return result.data.data;
  }
}
