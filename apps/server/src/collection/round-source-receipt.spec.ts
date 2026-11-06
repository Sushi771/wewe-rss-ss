import {
  createRoundSourceReceipt,
  roundSourceReceiptContext,
} from './round-source-receipt';
import { RedbookTransportDiagnosticError } from './redbook-client';

function fixture(failFirst = false) {
  const writes: any[] = [];
  const tx = {
    $queryRawUnsafe: jest.fn(),
    $executeRawUnsafe: jest.fn(async (_sql: string, value: string) => {
      if (failFirst && writes.length === 0) {
        writes.push('failed');
        throw Error('PRIVATE_ERROR');
      }
      writes.push(JSON.parse(value));
      return 1;
    }),
  };
  const receipt = createRoundSourceReceipt(async (fn) => fn(tx), 'review', {
    operationId: 'operation',
    creatorId: 'creator',
    taskId: 'task',
    phase: 'list',
    target: 'page:1',
  });
  return { receipt, writes, tx };
}
it('persists admission before transport and records response separately from failed storage', async () => {
  const { receipt, writes, tx } = fixture();
  await receipt.start();
  expect(writes[0].stage).toBe('admitted');
  await receipt.run(async () => {
    const observer = roundSourceReceiptContext.getStore()!;
    observer.observe('transport');
    observer.observe('sent');
    observer.observe('response', 200);
    observer.observe('parse');
  });
  receipt.observe('storage');
  await receipt.drain();
  receipt.fail({ code: 'P2002', message: 'SECRET_RESPONSE_BODY' });
  await receipt.persist(tx);
  expect(writes.at(-1)).toMatchObject({
    stage: 'storage',
    status: 200,
    outcome: 'local-failure',
    code: 'XHS_STORAGE_FAILED',
    terminal: true,
  });
  expect(JSON.stringify(writes)).not.toContain('SECRET');
  expect(roundSourceReceiptContext.getStore()).toBeUndefined();
});
it.each([
  ['guard-headers', true, 'not-sent'],
  ['timeout', false, 'unknown'],
] as const)(
  'retains fixed transport diagnostics for %s',
  async (kind, notSent, outcome) => {
    const { receipt, writes, tx } = fixture();
    await receipt.start();
    receipt.observe('transport', undefined, notSent);
    await receipt.drain();
    receipt.fail(
      new RedbookTransportDiagnosticError(kind, notSent, 'ECONNRESET'),
    );
    await receipt.persist(tx);
    expect(writes.at(-1)).toMatchObject({
      transportFailure: kind,
      nativeCode: 'ECONNRESET',
      outcome,
      terminal: true,
    });
  },
);
it('does not run transport when admitted receipt persistence fails', async () => {
  const { receipt } = fixture(true);
  const transport = jest.fn();
  await expect(
    (async () => {
      await receipt.start();
      return receipt.run(transport);
    })(),
  ).rejects.toThrow('PRIVATE_ERROR');
  expect(transport).not.toHaveBeenCalled();
});
it('drains a failed stage write and permits a terminal recovery attempt without replay', async () => {
  const { receipt, writes, tx } = fixture(true);
  await expect(receipt.start()).rejects.toThrow();
  receipt.fail(Error('SECRET'));
  await receipt.persist(tx);
  expect(writes.at(-1)).toMatchObject({ outcome: 'not-sent', terminal: true });
  receipt.observe('sent');
  await expect(receipt.drain()).rejects.toThrow();
  expect(writes).toHaveLength(2);
});

it('classifies a failed checkpoint transaction as local failure rather than saved', async () => {
  const { receipt, writes, tx } = fixture();
  await receipt.start();
  receipt.observe('response', 200);
  receipt.observe('storage');
  await receipt.drain();
  receipt.complete();
  receipt.fail({ code: 'P2028' });
  await receipt.persist(tx);
  expect(writes.at(-1)).toMatchObject({
    stage: 'checkpoint',
    outcome: 'local-failure',
    code: 'XHS_STORAGE_FAILED',
    status: 200,
  });
});
it('fails closed if the durable request binding changes', async () => {
  const { receipt, tx } = fixture();
  tx.$executeRawUnsafe.mockResolvedValueOnce(0);
  await expect(receipt.start()).rejects.toThrow(
    'ROUND_RECEIPT_BINDING_CHANGED',
  );
});
