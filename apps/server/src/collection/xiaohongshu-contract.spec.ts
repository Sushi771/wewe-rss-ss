import {
  appendXhsPage,
  retainXhsArchiveDraft,
  xhsArchiveDraft,
  xhsPageLedger,
  XhsNormalizedCandidate,
} from './xiaohongshu-contract';
import { allowedImageUrl } from './image-fetch';

// Synthetic internal DTOs, NOT supplier response fixtures or real XHS samples.
const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=';
const fixture = (
  overrides: Partial<XhsNormalizedCandidate> = {},
): XhsNormalizedCandidate => ({
  authorId: 'synthetic-author',
  noteId: 'synthetic-note',
  kind: 'image-text',
  publishedAt: 1700000000,
  title: '合成标题',
  text: '合成完整段落\n第二段',
  textStatus: 'full',
  expectedImageCount: 1,
  images: [{ ordinal: 1, inlineData: png }],
  ...overrides,
});
const page = (
  requestCursor: string | null,
  nextCursor: string | null,
  notes: string[],
) => ({
  authorId: 'synthetic-author',
  requestCursor,
  nextCursor,
  items: notes.map((noteId) => ({ authorId: 'synthetic-author', noteId })),
});

describe('XHS internal identity/pagination/archive contract (synthetic offline)', () => {
  let network: jest.SpyInstance;
  beforeEach(() => {
    network = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
  });
  afterEach(() => {
    expect(network).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });
  it('keeps platform and author/note identities separate without MP IDs or guessed ID grammar', () => {
    const draft = xhsArchiveDraft('synthetic-author', fixture());
    expect(JSON.parse(draft.authorKey)).toEqual([
      'xiaohongshu',
      'author',
      'synthetic-author',
    ]);
    expect(JSON.parse(draft.noteKey)).toEqual([
      'xiaohongshu',
      'note',
      'synthetic-note',
    ]);
    expect(draft.verified).toBe(false);
    expect(draft.status).toBe('candidate');
    const sharedId = xhsArchiveDraft(
      'same',
      fixture({ authorId: 'same', noteId: 'same' }),
    );
    expect(sharedId.authorKey).not.toBe(sharedId.noteKey);
  });
  it('rejects foreign author, missing identity and absent publication time', () => {
    expect(() => xhsArchiveDraft('other', fixture())).toThrow(
      'XHS_AUTHOR_MISMATCH',
    );
    expect(() =>
      xhsArchiveDraft('synthetic-author', fixture({ noteId: '' })),
    ).toThrow('XHS_IDENTITY_INVALID');
    expect(() =>
      xhsArchiveDraft('synthetic-author', fixture({ publishedAt: 0 })),
    ).toThrow('XHS_PUBLICATION_TIME_MISSING');
  });
  it('rejects a millisecond value instead of guessing a supplier time conversion', () => {
    expect(() =>
      xhsArchiveDraft(
        'synthetic-author',
        fixture({ publishedAt: 1700000000000 }),
      ),
    ).toThrow('XHS_PUBLICATION_TIME_MISSING');
  });
  it('deduplicates across pages and continues after a pinned/entirely duplicated page', () => {
    let ledger = xhsPageLedger('synthetic-author');
    const first = appendXhsPage(
      ledger,
      page(null, 'synthetic-cursor-1', ['pinned-old', 'one', 'one']),
      3,
    );
    ledger = first.ledger;
    expect(first.newNoteKeys).toHaveLength(2);
    const repeated = appendXhsPage(
      ledger,
      page('synthetic-cursor-1', 'synthetic-cursor-2', ['pinned-old', 'one']),
      3,
    );
    expect(repeated.newNoteKeys).toHaveLength(0);
    expect(repeated.ledger.supplierReportedEnd).toBe(false);
    const final = appendXhsPage(
      repeated.ledger,
      page('synthetic-cursor-2', null, ['two']),
      3,
    );
    expect(final.newNoteKeys).toHaveLength(1);
    expect(final.ledger.noteKeys).toHaveLength(3);
    expect(final.ledger.supplierReportedEnd).toBe(true);
    expect(ledger.noteKeys).toHaveLength(2);
  });
  it('rejects replay, cycles and foreign ownership before changing the caller ledger', () => {
    const ledger = appendXhsPage(
      xhsPageLedger('synthetic-author'),
      page(null, 'cursor-1', ['one']),
      3,
    ).ledger;
    const before = JSON.stringify(ledger);
    expect(() =>
      appendXhsPage(ledger, page(null, 'cursor-2', ['two']), 3),
    ).toThrow('XHS_CURSOR_REPLAY');
    expect(() =>
      appendXhsPage(ledger, page('cursor-1', 'cursor-1', ['two']), 3),
    ).toThrow('XHS_CURSOR_CYCLE');
    const foreign = page('cursor-1', null, ['two']);
    foreign.items[0].authorId = 'other';
    expect(() => appendXhsPage(ledger, foreign, 3)).toThrow(
      'XHS_AUTHOR_MISMATCH',
    );
    expect(JSON.stringify(ledger)).toBe(before);
  });
  it('budget stop is an unfinished window, independent of duplicate count', () => {
    const ledger = appendXhsPage(
      xhsPageLedger('synthetic-author'),
      page(null, 'cursor-1', ['one']),
      1,
    ).ledger;
    expect(ledger.supplierReportedEnd).toBe(false);
    expect(() =>
      appendXhsPage(ledger, page('cursor-1', null, ['two']), 1),
    ).toThrow('XHS_PAGE_WINDOW_STOPPED');
  });
  it('preserves actual cached bytes/order and never upgrades a draft to verified content', () => {
    const draft = xhsArchiveDraft(
      'synthetic-author',
      fixture({
        expectedImageCount: 2,
        images: [
          { ordinal: 1, inlineData: png },
          { ordinal: 2, inlineData: png },
        ],
      }),
    );
    if (draft.status !== 'candidate') throw new Error('unexpected skip');
    expect(draft.readyForEvidenceCheck).toBe(true);
    expect(draft.images.map((i) => i.ordinal)).toEqual([1, 2]);
    expect(draft.images[0].bytes.toString('base64')).toBe(png.split(',')[1]);
    expect(draft.images[0].sha256).toHaveLength(64);
    expect(draft.verified).toBe(false);
    expect(draft.text).toContain('第二段');
  });
  it('summary, unknown image count or incomplete bytes cannot become a complete candidate', () => {
    for (const candidate of [
      fixture({ textStatus: 'summary' }),
      fixture({ expectedImageCount: null }),
      fixture({ expectedImageCount: 2 }),
    ]) {
      const draft = xhsArchiveDraft('synthetic-author', candidate);
      expect(draft.status === 'candidate' && draft.readyForEvidenceCheck).toBe(
        false,
      );
    }
    expect(() =>
      xhsArchiveDraft(
        'synthetic-author',
        fixture({
          images: [
            {
              ordinal: 1,
              inlineData:
                'data:image/png;base64,' +
                Buffer.from('not a picture').toString('base64'),
            },
          ],
        }),
      ),
    ).toThrow('IMAGE_RESPONSE_INVALID');
    const truncated = Buffer.from(png.split(',')[1], 'base64').subarray(0, -12);
    expect(() =>
      xhsArchiveDraft(
        'synthetic-author',
        fixture({
          images: [
            {
              ordinal: 1,
              inlineData:
                'data:image/png;base64,' + truncated.toString('base64'),
            },
          ],
        }),
      ),
    ).toThrow('IMAGE_RESPONSE_INVALID');
  });
  it('rejects reordered images and leaves the original WeChat network allowlist intact', () => {
    expect(() =>
      xhsArchiveDraft(
        'synthetic-author',
        fixture({ images: [{ ordinal: 2, inlineData: png }] }),
      ),
    ).toThrow('XHS_IMAGE_ORDER_INVALID');
    expect(() =>
      allowedImageUrl('https://synthetic-xhs-cdn.example/photo.png'),
    ).toThrow('IMAGE_SOURCE_NOT_ALLOWED');
  });
  it('rejects missing image slots instead of treating array length as cached image bytes', () => {
    const images = new Array<XhsNormalizedCandidate['images'][number]>(2);
    images[0] = { ordinal: 1, inlineData: png };
    expect(() =>
      xhsArchiveDraft(
        'synthetic-author',
        fixture({ expectedImageCount: 2, images }),
      ),
    ).toThrow('XHS_IMAGE_ORDER_INVALID');
  });
  it('text-only is valid with an explicitly known zero images, while video remains skipped', () => {
    const text = xhsArchiveDraft(
      'synthetic-author',
      fixture({ expectedImageCount: 0, images: [] }),
    );
    expect(text.status === 'candidate' && text.readyForEvidenceCheck).toBe(
      true,
    );
    const video = xhsArchiveDraft(
      'synthetic-author',
      fixture({ kind: 'video' }),
    );
    expect(video.status).toBe('video-skipped');
    expect(video.verified).toBe(false);
  });
  it('an empty/summary update preserves existing candidate text/images and never moves author ownership', () => {
    const old = xhsArchiveDraft('synthetic-author', fixture());
    const incomplete = xhsArchiveDraft(
      'synthetic-author',
      fixture({
        text: '',
        textStatus: 'summary',
        images: [],
        expectedImageCount: null,
      }),
    );
    expect(retainXhsArchiveDraft(old, incomplete)).toBe(old);
    const foreign = xhsArchiveDraft('other', fixture({ authorId: 'other' }));
    expect(() => retainXhsArchiveDraft(old, foreign)).toThrow(
      'XHS_ARCHIVE_IDENTITY_CONFLICT',
    );
  });
});
