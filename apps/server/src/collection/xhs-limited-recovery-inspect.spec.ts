import { inspectLimitedRecovery } from './xhs-limited-recovery-inspect';

const fixture = () => ({
  items: [
    {
      id: 'synthetic-note',
      note_card: {
        note_id: 'synthetic-note',
        user: { user_id: 'synthetic-author', nickname: 'Synthetic' },
        type: 'normal',
        time: 1760000000000,
        title: 'Synthetic title',
        desc: 'Synthetic body',
        interact_info: {
          liked_count: '0',
          collected_count: '2',
          share_count: '3',
          comment_count: '4',
        },
        image_list: [
          {
            url_default:
              'https://sns-webpic.xhscdn.com/synthetic.jpg?token=synthetic-only',
          },
        ],
      },
    },
  ],
});

describe('limited recovery detail projection (offline)', () => {
  it('retains body, exact counts and a non-secret pending media fingerprint', () => {
    const result = inspectLimitedRecovery(
      fixture(),
      'synthetic-author',
      'synthetic-note',
    );
    expect(result.text).toBe('Synthetic body');
    expect(result.metrics.values).toEqual({
      likes: 0,
      collects: 2,
      shares: 3,
      comments: 4,
    });
    expect(result.media).toEqual([
      {
        ordinal: 1,
        state: 'not-downloaded',
        sourceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        sourceUrl: 'https://sns-webpic.xhscdn.com/synthetic.jpg',
        sourceQueryOmitted: true,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('synthetic-only');
    expect(JSON.stringify(result)).not.toContain('?token=');
  });
  it('rejects mismatched author or note before returning data', () => {
    expect(() =>
      inspectLimitedRecovery(fixture(), 'other-author', 'synthetic-note'),
    ).toThrow();
    expect(() =>
      inspectLimitedRecovery(fixture(), 'synthetic-author', 'other-note'),
    ).toThrow();
  });
  it('preserves unknown metrics rather than inventing zero', () => {
    const raw = fixture();
    raw.items[0].note_card.interact_info = {} as any;
    expect(
      inspectLimitedRecovery(raw, 'synthetic-author', 'synthetic-note').metrics
        .values,
    ).toEqual({ likes: null, collects: null, shares: null, comments: null });
  });
});
