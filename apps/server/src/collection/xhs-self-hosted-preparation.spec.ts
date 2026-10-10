import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as helpers from './xhs-self-hosted-config';

const root = path.resolve(__dirname, '../../../..');
const folder = path.join(root, '.xhs-self-hosted');
const configFile = path.join(folder, '.env.local');
const templateFile = path.join(root, '.env.xhs-self-hosted.example');
const script = fs.readFileSync(
  path.join(root, 'scripts/prepare-xhs-self-hosted.cjs'),
  'utf8',
);
type Entry = { kind: 'file' | 'dir' | 'link'; body?: string };

function preparation(
  args: string[],
  options: {
    config?: string;
    folderLink?: boolean;
    buildMissing?: boolean;
    readFailed?: boolean;
  } = {},
) {
  const files = new Map<string, Entry>([
    [
      templateFile,
      {
        kind: 'file',
        body: 'XHS_SELF_HOSTED_BASE_URL=\nXHS_SELF_HOSTED_API_KEY=\n',
      },
    ],
  ]);
  if (options.config !== undefined) {
    files.set(folder, { kind: 'dir' });
    files.set(configFile, { kind: 'file', body: options.config });
  }
  if (options.folderLink) files.set(folder, { kind: 'link' });
  const reads: string[] = [];
  const copies: string[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const processState = {
    argv: ['node', 'synthetic-preparation', ...args],
    exitCode: undefined as number | undefined,
  };
  vm.runInNewContext(
    script,
    {
      __dirname: path.join(root, 'scripts'),
      process: processState,
      Error,
      console: {
        log: (value: string) => logs.push(value),
        error: (value: string) => errors.push(value),
      },
      require: (name: string) => {
        if (name === 'node:fs')
          return {
            constants: fs.constants,
            existsSync: (file: string) => files.has(file),
            lstatSync: (file: string) => ({
              isDirectory: () => files.get(file)?.kind === 'dir',
              isFile: () => files.get(file)?.kind === 'file',
              isSymbolicLink: () => files.get(file)?.kind === 'link',
            }),
            mkdirSync: (file: string) => files.set(file, { kind: 'dir' }),
            copyFileSync: (from: string, to: string, flags: number) => {
              expect(flags).toBe(fs.constants.COPYFILE_EXCL);
              if (files.has(to)) throw new Error('SYNTHETIC_EXISTING_FILE');
              copies.push(to);
              files.set(to, { kind: 'file', body: files.get(from)?.body });
            },
            readFileSync: (file: string) => {
              reads.push(file);
              if (file !== configFile)
                throw new Error('UNEXPECTED_CONFIG_READ');
              if (options.readFailed)
                throw new Error('EACCES synthetic-private-path-and-secret');
              return Buffer.from(files.get(file)?.body || '');
            },
          };
        if (name.endsWith('xhs-self-hosted-config.js')) {
          if (options.buildMissing) throw new Error('SYNTHETIC_BUILD_MISSING');
          return helpers;
        }
        return require(name);
      },
    },
    { timeout: 1000 },
  );
  return {
    files,
    reads,
    copies,
    logs: logs.map((value) => JSON.parse(value)),
    errors,
    processState,
  };
}

describe('self-hosted preparation CLI (synthetic filesystem only)', () => {
  let network: jest.SpyInstance;
  beforeEach(() => {
    network = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
  });
  afterEach(() => {
    try {
      expect(network).not.toHaveBeenCalled();
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('prepares empty isolated folders without reading or creating credentials', () => {
    const result = preparation(['--prepare']);
    expect(result.errors).toEqual([]);
    expect(result.logs[0]).toMatchObject({
      mode: 'prepare-only',
      configCreated: true,
      sourceReviewed: false,
      canRefresh: false,
    });
    expect(result.reads).toEqual([]);
    expect(result.copies).toEqual([configFile]);
    for (const name of ['delivery', 'review', 'test-data', 'logs'])
      expect(result.files.get(path.join(folder, name))?.kind).toBe('dir');
    expect(result.files.get(configFile)?.body).toBe(
      'XHS_SELF_HOSTED_BASE_URL=\nXHS_SELF_HOSTED_API_KEY=\n',
    );
  });

  it('preserves an existing filled configuration without reading it during preparation', () => {
    const config = 'XHS_SELF_HOSTED_API_KEY=synthetic-private-existing-key\n';
    const result = preparation(['--prepare'], { config });
    expect(result.errors).toEqual([]);
    expect(result.logs[0].configCreated).toBe(false);
    expect(result.reads).toEqual([]);
    expect(result.copies).toEqual([]);
    expect(result.files.get(configFile)?.body).toBe(config);
    expect(JSON.stringify(result.logs)).not.toContain(
      'synthetic-private-existing-key',
    );
  });

  it('rejects a substituted preparation directory without following or writing it', () => {
    const result = preparation(['--prepare'], { folderLink: true });
    expect(result.errors).toEqual(['XHS_PREPARATION_PATH_INVALID']);
    expect(result.copies).toEqual([]);
    expect(result.reads).toEqual([]);
    expect(result.processState.exitCode).toBe(1);
  });

  it.each<{ args: string[] }>([
    { args: [] },
    { args: ['--execute'] },
    { args: ['--prepare', '--check-config'] },
  ])('rejects unsupported modes before filesystem work: %j', ({ args }) => {
    const result = preparation(args);
    expect(result.errors).toEqual(['XHS_PREPARATION_ARGUMENT_INVALID']);
    expect(result.files.size).toBe(1);
    expect(result.reads).toEqual([]);
  });

  it('reports a missing candidate file without generating one', () => {
    const result = preparation(['--check-config']);
    expect(result.errors).toEqual(['XHS_PREPARATION_CONFIG_MISSING']);
    expect(result.reads).toEqual([]);
    expect(result.copies).toEqual([]);
  });

  const config =
    'XHS_SELF_HOSTED_BASE_URL=http://127.0.0.1:54321/private-path\nXHS_SELF_HOSTED_API_KEY=synthetic-key\n';
  it('uses the actual candidate parser and never upgrades valid config into a verified source', () => {
    const result = preparation(['--check-config'], { config });
    expect(result.errors).toEqual([]);
    expect(result.logs[0]).toMatchObject({
      configured: true,
      sourceReviewed: false,
      verifiedBodySource: false,
      canRefresh: false,
    });
    expect(JSON.stringify(result.logs)).not.toMatch(
      /54321|private-path|synthetic-key/,
    );
    expect(result.reads).toEqual([configFile]);
    expect(result.copies).toEqual([]);
  });

  it('reports fixed build and read errors without values or retry', () => {
    const missing = preparation(['--check-config'], {
      config,
      buildMissing: true,
    });
    expect(missing.errors).toEqual(['SERVER_BUILD_REQUIRED']);
    expect(missing.reads).toEqual([]);
    const denied = preparation(['--check-config'], {
      config,
      readFailed: true,
    });
    expect(denied.errors).toEqual(['XHS_PREPARATION_CONFIG_READ_FAILED']);
    expect(denied.reads).toEqual([configFile]);
    expect(denied.processState.exitCode).toBe(1);
  });

  it('fails empty configuration safely and never invokes vendor code', () => {
    const result = preparation(['--check-config'], { config: '' });
    expect(result.logs[0]).toMatchObject({
      configured: false,
      canRefresh: false,
    });
    expect(result.processState.exitCode).toBe(1);
    expect(result.copies).toEqual([]);
  });
});
