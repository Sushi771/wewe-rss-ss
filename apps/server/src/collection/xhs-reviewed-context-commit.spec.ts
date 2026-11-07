jest.mock('./xhs-reviewed-attempt', () => ({
  ...jest.requireActual('./xhs-reviewed-attempt'),
  startReviewedContextStage: jest.fn(),
  enterReviewedContextStage: jest.fn(),
  assertEnteredReviewedContextStage: jest.fn(),
  settleReviewedContextStage: jest.fn(),
}));
import * as stages from './xhs-reviewed-attempt';
import {
  dispatchReviewedContextStage,
  consumeReviewedContextPermit,
  type ContextBinding,
  type RecoveryWriter,
} from './xhs-reviewed-dispatch';

// Control-flow port tests, complemented by the real SQLite bounded-context
// suites. No database/host admission or transport is represented as production.
it.each([
  'success',
  'commit-failed',
  'risk-changed',
  'session-changed',
  'marker-changed',
  'new-unknown',
  'reader-failed',
  'reader-commit-failed',
])(
  'starts a reviewed context transport only after commit and fresh durable checks: %s',
  async (mode) => {
    jest.clearAllMocks();
    const order: string[] = [];
    let writes = 0,
      committedEntry = false;
    const binding: ContextBinding = {
      jobId: 'synthetic-job',
      id: 'a'.repeat(64),
      authorId: 'synthetic-author',
      noteId: 'synthetic-note',
      phase: 'list',
    };
    const started = {
      marker: 'synthetic-marker',
      owner: {
        pid: 1,
        startIdentity: 'synthetic-start',
        nonce: '00000000-0000-4000-8000-000000000001',
      },
    };
    (stages.startReviewedContextStage as jest.Mock).mockResolvedValue(started);
    (stages.enterReviewedContextStage as jest.Mock).mockResolvedValue({
      state: 'entered',
    });
    (stages.settleReviewedContextStage as jest.Mock).mockResolvedValue(
      undefined,
    );
    (stages.assertEnteredReviewedContextStage as jest.Mock).mockImplementation(
      async () => {
        expect(committedEntry).toBe(true);
        order.push('durable-check');
        if (['risk-changed', 'marker-changed', 'new-unknown'].includes(mode))
          throw Error('SYNTHETIC_' + mode);
      },
    );
    const write: RecoveryWriter = async (fn) => {
      const index = ++writes;
      const result = await fn({} as any);
      if (index === 2 && mode === 'commit-failed')
        throw Error('SYNTHETIC_COMMIT_FAILED');
      if (index === 2) committedEntry = true;
      order.push('commit-' + index);
      return result;
    };
    const reader: RecoveryWriter = async (fn) => {
      expect(committedEntry).toBe(true);
      if (mode === 'reader-failed') throw Error('SYNTHETIC_READER_FAILED');
      const value = await fn({} as any);
      if (mode === 'reader-commit-failed')
        throw Error('SYNTHETIC_READER_COMMIT_FAILED');
      order.push('reader-complete');
      return value;
    };
    const ready = jest.fn(() => {
      if (committedEntry && mode === 'session-changed')
        throw Error('XHS_SESSION_CHANGED');
    });
    const admit = jest.fn(async () => {});
    const transport = jest.fn(async () => {
      expect(committedEntry).toBe(true);
      expect(order).toContain('reader-complete');
      order.push('physical-send');
      return 'synthetic-response';
    });
    let permit: object | undefined;
    const result = dispatchReviewedContextStage(
      write,
      binding,
      ready,
      async (value) => {
        permit = value;
        return consumeReviewedContextPermit(value, binding).dispatch(transport);
      },
      admit,
      reader,
    );
    if (mode === 'success') {
      await expect(result).resolves.toBe('synthetic-response');
      expect(transport).toHaveBeenCalledTimes(1);
      expect(order.indexOf('commit-2')).toBeLessThan(
        order.indexOf('durable-check'),
      );
      expect(order.indexOf('reader-complete')).toBeLessThan(
        order.indexOf('physical-send'),
      );
      expect(stages.settleReviewedContextStage).toHaveBeenCalledTimes(1);
    } else {
      await expect(result).rejects.toThrow();
      expect(transport).not.toHaveBeenCalled();
      expect(stages.settleReviewedContextStage).not.toHaveBeenCalled();
    }
    expect(stages.startReviewedContextStage).toHaveBeenCalledTimes(1);
    expect(() => consumeReviewedContextPermit(permit, binding)).toThrow();
  },
);

it('refuses a reviewed context without a durable reader before granting anything', async () => {
  const write = jest.fn(),
    transport = jest.fn();
  await expect(
    dispatchReviewedContextStage(write, {} as any, () => {}, transport),
  ).rejects.toThrow();
  expect(write).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
});
