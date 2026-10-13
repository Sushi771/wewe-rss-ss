import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { RnotePublicClient } from './rnote-public-client';
import { RnotePublicCandidate } from './rnote-public-candidate';

const root = path.resolve(__dirname, '../../../../..');
const script = fs.readFileSync(
  path.join(root, 'scripts/acceptance-rnote-public.cjs'),
  'utf8',
);
async function run(args: string[], config?: string) {
  const logs: string[] = [],
    errors: string[] = [],
    reads: string[] = [];
  const state = {
    argv: ['node', 'candidate-cli', ...args],
    exitCode: undefined as number | undefined,
  };
  const request = jest.fn().mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          success: true,
          billed: true,
          data: { data: { notes: [{ id: 'b'.repeat(24) }], has_more: false } },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  );
  await vm.runInNewContext(
    script,
    {
      __dirname: path.join(root, 'scripts'),
      process: state,
      fetch: request,
      Error,
      console: {
        log: (s: string) => logs.push(s),
        error: (s: string) => errors.push(s),
      },
      require: (name: string) => {
        if (name === 'node:fs')
          return {
            lstatSync: () => ({ isSymbolicLink: () => false }),
            readFileSync: (file: string) => {
              reads.push(file);
              if (config === undefined) throw new Error();
              return Buffer.from(config);
            },
          };
        if (name.endsWith('rnote-public-client.js'))
          return { RnotePublicClient };
        if (name.endsWith('rnote-public-candidate.js'))
          return { RnotePublicCandidate };
        return require(name);
      },
    },
    { timeout: 1000 },
  );
  return {
    logs: logs.map((s) => JSON.parse(s)),
    errors,
    reads,
    state,
    request,
  };
}
describe('explicit public-contract CLI, synthetic files and response only', () => {
  it('default invocation does not even read a configured private file', async () => {
    const result = await run(
      [],
      'XHS_SELF_HOSTED_API_KEY=synthetic-private-key',
    );
    expect(result.logs[0].mode).toBe('no-request');
    expect(result.reads).toEqual([]);
    expect(result.request).not.toHaveBeenCalled();
  });
  it('executes exactly one selected request and never dumps business data or credentials', async () => {
    const result = await run(
      ['--execute', '--operation', 'posted', '--id', 'a'.repeat(24)],
      'XHS_SELF_HOSTED_BASE_URL=http://127.0.0.1:12345/\nXHS_SELF_HOSTED_API_KEY=synthetic-private-key',
    );
    expect(result.errors).toEqual([]);
    expect(result.request).toHaveBeenCalledTimes(1);
    expect(result.logs[0]).toMatchObject({
      requests: 1,
      candidateCount: 1,
      canRefresh: false,
      evidenceVerified: false,
    });
    expect(JSON.stringify(result.logs)).not.toMatch(
      /synthetic-private|127\.0\.0\.1|bbbbbbbb/,
    );
  });
  it('missing Key blocks the request after explicit invocation', async () => {
    const result = await run(
      ['--execute', '--operation', 'posted', '--id', 'a'.repeat(24)],
      'XHS_SELF_HOSTED_BASE_URL=http://127.0.0.1:12345/',
    );
    expect(result.errors).toEqual(['RNOTE_KEY_MISSING']);
    expect(result.request).not.toHaveBeenCalled();
  });
  it('invalid operation is rejected before private file read', async () => {
    const result = await run([
      '--execute',
      '--operation',
      'automatic-fallback',
      '--id',
      'a'.repeat(24),
    ]);
    expect(result.errors).toEqual(['RNOTE_ARGUMENT_INVALID']);
    expect(result.reads).toEqual([]);
  });
});
