import axios from 'axios';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { CollectionService } from './collection.service';
import { createVerifiedSqliteBackup } from './sqlite-backup';
import {
  fetchLiveOwnerArticles,
  readOwnerSearchConfig,
} from './owner-search-update';
import { OwnerWebSession } from './owner-web-search';
import {
  NativeWereadAccount,
  nativeAccountIndexFile,
  resolveNativeWereadAccount,
} from './owner-weread-account';
import {
  continueVerifiedWereadCandidate,
  validateWereadPublisherCandidate,
  wereadPublisherCandidateFromOriginal,
  withVerifiedWereadCandidateBinding,
} from './weread-publisher-validation';

jest.mock('axios');
jest.mock('./sqlite-backup', () => ({
  createVerifiedSqliteBackup: jest
    .fn()
    .mockResolvedValue({ integrityCheck: 'ok' }),
}));
jest.mock('node:timers/promises', () => ({
  setTimeout: jest.fn().mockResolvedValue(undefined),
}));
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const mpId = 'MP_WXS_1234567890';
const name = '测试公众号';
const biz = Buffer.from('1234567890').toString('base64');
const token = (n: number) => 'a'.repeat(20) + String(n).padStart(2, '0');
const url = (n: number) =>
  `https://mp.weixin.qq.com/s?__biz=${encodeURIComponent(biz)}&mid=${100 + n}&idx=1&sn=abcdef1234`;
const html = (
  n = 1,
  image = false,
) => `<html><head><meta property="og:url" content="${url(n)}"></head>
<script>var biz="${biz}";var mid="${100 + n}";var idx="1";var sn="abcdef1234";var ct="${1700000100 - n}";</script>
<h1 id="activity-name">文章${n}</h1><a id="js_name">${name}</a><div id="js_content">正文${n}${image ? '<img data-src="https://mmbiz.qpic.cn/synthetic.png">' : ''}</div></html>`;
const group = (n: number) => {
  const reviewId = `${mpId}_${token(n)}`;
  return {
    subReviews: [
      {
        reviewId,
        review: {
          reviewId,
          type: 16,
          bookId: '',
          belongBookId: mpId,
          mpInfo: {
            originalId: token(n),
            mp_name: name,
            title: `文章${n}`,
            time: 1700000100 - n,
            pic_url: '',
          },
        },
      },
    ],
  };
};
const page = (from = 1, count = 10) => ({
  reviews: Array.from({ length: count }, (_, i) => group(i + from)),
  synckey: 987654321,
  clearAll: 1,
});

describe('publisher candidate directory: offline transport and success-only binding', () => {
  let dir: string,
    configFile: string,
    account: NativeWereadAccount,
    session: OwnerWebSession;
  let fetchSpy: jest.SpyInstance;
  const attemptFile = () =>
    path.join(dir, `candidate-directory-${sha(mpId).slice(0, 24)}.json`);
  const validate = () =>
    validateWereadPublisherCandidate({
      account,
      publicArticleHtml: html(),
      configFile,
      trigger: 'local-manual',
    });
  const installSession = async () => {
    const text = JSON.stringify(session);
    const file = path.join(
      dir,
      `native-session-${sha(text).slice(0, 24)}.json`,
    );
    await fs.writeFile(file, text);
    await fs.writeFile(
      nativeAccountIndexFile(configFile, account.id),
      JSON.stringify({ sessionFile: file }),
    );
    return file;
  };
  beforeEach(async () => {
    jest.clearAllMocks();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-candidate-offline-'));
    configFile = path.join(dir, 'config.json');
    await fs.writeFile(configFile, JSON.stringify({ feeds: {} }));
    account = {
      id: '123',
      name: '合成测试账号',
      status: 1,
      token: JSON.stringify({
        wr_vid: '123',
        wr_skey: 'synthetic-private-key',
      }),
    };
    session = {
      source: 'owner-confirmed-native-web-login',
      ownerVid: '123',
      capturedAt: new Date(Date.now() - 1000).toISOString(),
      cookies: [
        {
          name: 'wr_skey',
          value: 'synthetic-private-key',
          domain: 'weread.qq.com',
          path: '/',
          secure: true,
          expires: -1,
        },
        {
          name: 'wr_vid',
          value: '123',
          domain: 'weread.qq.com',
          path: '/',
          secure: true,
          expires: -1,
        },
      ],
    };
    await installSession();
    (axios.get as jest.Mock).mockReset().mockResolvedValue({
      status: 200,
      data: JSON.stringify(page()),
      headers: {},
    });
    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('UNEXPECTED_EXTERNAL_NETWORK'));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    // Test owns this exact mkdtemp directory; no production paths are involved.
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('validates without a prior target binding, serializes no credentials and does not activate a feed', async () => {
    const before = await fs.readFile(configFile, 'utf8');
    const result = await validate();
    expect(result.status).toBe('directory-verified');
    expect(result.candidate.bookIdStatus).toBe('candidate');
    expect(result.directory.articles).toHaveLength(10);
    expect(result.bindingEvidence).toMatchObject({
      mpId,
      accountId: '123',
      requests: 1,
      bodyVerified: false,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /synthetic-private-key|sessionFile|cookies|token|native-session|<html>/,
    );
    expect(await fs.readFile(configFile, 'utf8')).toBe(before);
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect((axios.get as jest.Mock).mock.calls[0]).toEqual([
      'https://weread.qq.com/web/mp/articles',
      expect.objectContaining({
        params: { bookId: mpId, offset: '0' },
        maxRedirects: 0,
        proxy: false,
        timeout: 20000,
      }),
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    [
      'disabled account',
      () => {
        account.status = 0;
      },
    ],
    [
      'different database key',
      () => {
        account.token = JSON.stringify({ wr_vid: '123', wr_skey: 'different' });
      },
    ],
    [
      'different owner',
      () => {
        session.ownerVid = '999';
      },
    ],
    [
      'dedicated login',
      () => {
        session.source = 'owner-confirmed-dedicated-web-login';
      },
    ],
    [
      'expired key',
      () => {
        session.cookies[0].expires = Math.floor(Date.now() / 1000) - 1;
      },
    ],
  ])(
    'refuses %s before any transport or attempt reservation',
    async (_, change) => {
      change();
      await installSession();
      await expect(validate()).rejects.toMatchObject({
        code: 'ACCOUNT_NOT_READY',
      });
      expect(axios.get).not.toHaveBeenCalled();
      await expect(fs.access(attemptFile())).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );

  it('uses the same immutable account verification without a publisher config', async () => {
    const context = await resolveNativeWereadAccount(account, configFile);
    expect(context.authHash).toMatch(/^[a-f0-9]{64}$/);
    await fs.appendFile(context.sessionFile, ' ');
    await expect(validate()).rejects.toMatchObject({
      code: 'ACCOUNT_NOT_READY',
    });
    expect(axios.get).not.toHaveBeenCalled();
  });

  it.each([
    ['body fragment', '<div id="js_content">only body</div>'],
    ['verification page', '<div id="verify">verification required</div>'],
    ['conflicting original link', html().replace('mid=101', 'mid=999')],
    ['missing publisher', html().replace(name, '')],
    ['missing original link', html().replace(/<meta[^>]+>/, '')],
    ['missing body timestamp', html().replace(/var ct="\d+";/, '')],
  ])('does not elevate %s to a candidate', async (_, original) => {
    await expect(
      validateWereadPublisherCandidate({
        account,
        publicArticleHtml: original,
        configFile,
        trigger: 'local-manual',
      }),
    ).rejects.toMatchObject({ code: 'PUBLIC_IDENTITY_INVALID' });
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('keeps publicly derived bookId a candidate until directory evidence exists', () => {
    expect(wereadPublisherCandidateFromOriginal(html())).toMatchObject({
      mpId,
      name,
      bookIdStatus: 'candidate',
    });
    expect(axios.get).not.toHaveBeenCalled();
  });

  it.each([
    [
      401,
      JSON.stringify({
        errCode: -2012,
        privateMessage: 'SYNTHETIC_SECRET_MESSAGE',
      }),
      'UPSTREAM_HTTP',
      401,
      undefined,
    ],
    [
      200,
      JSON.stringify({ errCode: -2041, errMsg: 'SYNTHETIC_SECRET_MESSAGE' }),
      'UPSTREAM_BUSINESS',
      undefined,
      -2041,
    ],
    [
      200,
      JSON.stringify({ errCode: 0, code: -2041 }),
      'UPSTREAM_BUSINESS',
      undefined,
      -2041,
    ],
    [302, '<html>redirect</html>', 'UPSTREAM_HTTP', 302, undefined],
    [
      200,
      '<html>not directory</html>',
      'DIRECTORY_INVALID',
      undefined,
      undefined,
    ],
    [
      200,
      JSON.stringify({ errCode: 'SYNTHETIC_SECRET_MESSAGE' }),
      'DIRECTORY_INVALID',
      undefined,
      undefined,
    ],
    [
      200,
      JSON.stringify({ reviews: [] }),
      'EMPTY_DIRECTORY',
      undefined,
      undefined,
    ],
  ])(
    'persists a refusal at HTTP %s with safe code %s and never repeats it',
    async (status, data, code, httpStatus, businessCode) => {
      (axios.get as jest.Mock).mockResolvedValue({ status, data });
      await expect(validate()).rejects.toMatchObject({
        code,
        httpStatus,
        businessCode,
      });
      const text = await fs.readFile(attemptFile(), 'utf8');
      expect(JSON.parse(text).stop).toMatchObject({
        stage: 'directory-0',
        requests: 1,
      });
      expect(text).not.toContain('SYNTHETIC_SECRET_MESSAGE');
      expect(JSON.parse(text).bindingEvidence).toBeUndefined();
      expect(
        await fs.readFile(attemptFile() + '.directory-0.response', 'utf8'),
      ).toBe(data);
      await expect(validate()).rejects.toMatchObject({ code: 'RETAINED_STOP' });
      expect(await fs.readFile(attemptFile(), 'utf8')).toBe(text);
      expect(axios.get).toHaveBeenCalledTimes(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it.each(['publisher', 'belongBookId', 'reviewId', 'ordering'])(
    'rejects real directory %s conflict without binding evidence',
    async (field) => {
      const response = page();
      const entry = response.reviews[0].subReviews[0];
      if (field === 'publisher') entry.review.mpInfo.mp_name = '另一个公众号';
      if (field === 'belongBookId')
        entry.review.belongBookId = 'MP_WXS_9999999999';
      if (field === 'reviewId') entry.reviewId = mpId + '_wrong';
      if (field === 'ordering') response.reviews.reverse();
      (axios.get as jest.Mock).mockResolvedValue({
        status: 200,
        data: JSON.stringify(response),
      });
      await expect(validate()).rejects.toMatchObject({
        code: 'DIRECTORY_INVALID',
      });
      expect(
        JSON.parse(await fs.readFile(attemptFile(), 'utf8')).bindingEvidence,
      ).toBeUndefined();
      expect(axios.get).toHaveBeenCalledTimes(1);
    },
  );

  it('does not clear an old account stop to discover another target', async () => {
    const stateFile = path.join(dir, 'old-state.json');
    const state = JSON.stringify({
      stop: {
        at: new Date().toISOString(),
        stage: 'directory-0',
        requests: 1,
        reason: '业务码 -2041',
      },
    });
    await fs.writeFile(stateFile, state);
    await fs.writeFile(
      configFile,
      JSON.stringify({
        feeds: {
          MP_WXS_9999999999: {
            ownerVid: account.id,
            wereadLatestStateFile: stateFile,
          },
        },
      }),
    );
    await expect(validate()).rejects.toMatchObject({ code: 'RETAINED_STOP' });
    expect(await fs.readFile(stateFile, 'utf8')).toBe(state);
    expect(axios.get).not.toHaveBeenCalled();
    expect((await fs.readdir(dir)).filter((x) => x.endsWith('.lock'))).toEqual(
      [],
    );
  });

  it('does not retry an already bound target through another selected account', async () => {
    const oldState = path.join(dir, 'other-account-stop.json');
    const stopped = JSON.stringify({
      stop: { stage: 'directory-0', reason: '业务码 -2041', requests: 1 },
    });
    await fs.writeFile(oldState, stopped);
    await fs.writeFile(
      configFile,
      JSON.stringify({
        feeds: { [mpId]: { ownerVid: '999', wereadLatestStateFile: oldState } },
      }),
    );
    await expect(validate()).rejects.toMatchObject({ code: 'RETAINED_STOP' });
    expect(await fs.readFile(oldState, 'utf8')).toBe(stopped);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('does not send HTTP when the durable reservation cannot be written', async () => {
    const open = fs.open.bind(fs);
    jest
      .spyOn(fs, 'open')
      .mockImplementation((file, flags, mode) =>
        String(file) === attemptFile()
          ? Promise.reject(new Error('SYNTHETIC_PRIVATE_FILESYSTEM_PATH'))
          : open(file, flags, mode),
      );
    await expect(validate()).rejects.toMatchObject({
      code: 'STATE_IO_FAILED',
      message: 'STATE_IO_FAILED',
    });
    expect(axios.get).not.toHaveBeenCalled();
    expect((await fs.readdir(dir)).filter((x) => x.endsWith('.lock'))).toEqual(
      [],
    );
  });

  it('rejects changed persisted evidence before the binding callback', async () => {
    const result = await validate();
    const state = JSON.parse(await fs.readFile(attemptFile(), 'utf8'));
    state.bindingEvidence.directorySha256 = sha('altered-directory');
    await fs.writeFile(attemptFile(), JSON.stringify(state));
    const commit = jest.fn();
    await expect(
      withVerifiedWereadCandidateBinding(result, commit),
    ).rejects.toMatchObject({ code: 'STATE_CHANGED' });
    expect(commit).not.toHaveBeenCalled();
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  it('cannot try a new target or switch accounts to replay a failed candidate', async () => {
    (axios.get as jest.Mock).mockResolvedValue({
      status: 200,
      data: JSON.stringify({ errCode: -2041 }),
    });
    await expect(validate()).rejects.toMatchObject({
      code: 'UPSTREAM_BUSINESS',
    });
    const otherHtml = html()
      .replaceAll(biz, Buffer.from('9999999999').toString('base64'))
      .replaceAll(
        encodeURIComponent(biz),
        encodeURIComponent(Buffer.from('9999999999').toString('base64')),
      );
    await expect(
      validateWereadPublisherCandidate({
        account,
        publicArticleHtml: otherHtml,
        configFile,
        trigger: 'local-manual',
      }),
    ).rejects.toMatchObject({ code: 'RETAINED_STOP' });
    account.id = '999';
    account.token = JSON.stringify({
      wr_vid: '999',
      wr_skey: 'synthetic-private-key',
    });
    session.ownerVid = '999';
    session.cookies[1].value = '999';
    await installSession();
    await expect(validate()).rejects.toMatchObject({
      code: 'ATTEMPT_CONSUMED',
    });
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  it('fails closed across success replay and an interrupted reservation', async () => {
    await validate();
    await expect(validate()).rejects.toMatchObject({
      code: 'ATTEMPT_CONSUMED',
    });
    expect(axios.get).toHaveBeenCalledTimes(1);
    // Existing reservation also applies after a different process loses the in-memory result.
    await fs.writeFile(
      attemptFile(),
      JSON.stringify({ status: 'reserved', accountId: '123' }),
    );
    await expect(validate()).rejects.toMatchObject({
      code: 'ATTEMPT_CONSUMED',
    });
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  it('refuses concurrent native-login or provider locks before request', async () => {
    await fs.writeFile(configFile + '.native-login.lock', 'synthetic busy');
    await expect(validate()).rejects.toMatchObject({ code: 'IN_PROGRESS' });
    expect(await fs.readFile(configFile + '.native-login.lock', 'utf8')).toBe(
      'synthetic busy',
    );
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('cannot bind a serialized/forged result, stale evidence or changed login', async () => {
    const result = await validate();
    const commit = jest.fn();
    await expect(
      withVerifiedWereadCandidateBinding(
        JSON.parse(JSON.stringify(result)),
        commit,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_EVIDENCE' });
    const state = await fs.readFile(attemptFile(), 'utf8');
    await fs.writeFile(attemptFile(), state + ' ');
    // JSON-equivalent whitespace does not alter business evidence.
    session.cookies[0].value = 'new-normal-login';
    await installSession();
    await expect(
      withVerifiedWereadCandidateBinding(result, commit),
    ).rejects.toMatchObject({ code: 'ACCOUNT_NOT_READY' });
    expect(commit).not.toHaveBeenCalled();
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  it('preserves a real SQLite rollback and permits only local binding retry', async () => {
    const result = await validate();
    const db = path.join(dir, 'transaction.sqlite');
    execFileSync('python', [
      '-c',
      'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("create table feeds(id text primary key)"); c.execute("insert into feeds values(?)",("old",)); c.commit()',
      db,
    ]);
    const before = await fs.readFile(attemptFile(), 'utf8');
    await expect(
      withVerifiedWereadCandidateBinding(result, async () => {
        execFileSync(
          'python',
          [
            '-c',
            'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]);\ntry:\n c.execute("BEGIN"); c.execute("insert into feeds values(?)",("new",)); c.execute("insert into feeds values(?)",("old",)); c.commit()\nexcept sqlite3.IntegrityError:\n c.rollback(); sys.exit(2)',
            db,
          ],
          { stdio: 'pipe' },
        );
      }),
    ).rejects.toMatchObject({ code: 'BINDING_FAILED' });
    expect(
      execFileSync(
        'python',
        [
          '-c',
          'import sqlite3,sys,json; print(json.dumps(sqlite3.connect(sys.argv[1]).execute("select id from feeds order by id").fetchall()))',
          db,
        ],
        { encoding: 'utf8' },
      ).trim(),
    ).toBe('[["old"]]');
    expect(await fs.readFile(attemptFile(), 'utf8')).toBe(before);
    await expect(continueVerifiedWereadCandidate(result)).rejects.toMatchObject(
      { code: 'BINDING_REQUIRED' },
    );
    const bound = await withVerifiedWereadCandidateBinding(
      result,
      async (context) => {
        expect(context.binding).toMatchObject({
          mpId,
          name,
          ownerVid: '123',
          wereadDirectoryEnabled: true,
        });
        expect(context.binding.sessionFile).toMatch(/native-session-/);
        return 'committed';
      },
    );
    expect(bound).toBe('committed');
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  it('provides a complete native-only private binding with no invented original-stop event', async () => {
    const result = await validate();
    const previousEnv = process.env.OWNER_SEARCH_CONFIG_FILE;
    try {
      process.env.OWNER_SEARCH_CONFIG_FILE = configFile;
      await withVerifiedWereadCandidateBinding(result, async ({ binding }) => {
        expect(binding.sourcePolicy).toBe('native-directory-only');
        expect(binding.originalStopFiles).toEqual([]);
        await fs.writeFile(
          configFile,
          JSON.stringify({ feeds: { [mpId]: binding } }),
        );
      });
      const binding = await readOwnerSearchConfig(mpId);
      expect(binding).toMatchObject({
        mpId,
        name,
        sourcePolicy: 'native-directory-only',
        wereadDirectoryEnabled: true,
        originalStopFiles: [],
      });
      await expect(fetchLiveOwnerArticles(binding)).rejects.toThrow(
        '公开原文采集与搜索未启用',
      );
      expect(axios.get).toHaveBeenCalledTimes(1);
      expect(axios.post).not.toHaveBeenCalled();
      // Dropping the explicit policy cannot turn empty historical stops into
      // an accepted general search binding.
      const legacy = { ...binding };
      delete legacy.sourcePolicy;
      await fs.writeFile(
        configFile,
        JSON.stringify({ feeds: { [mpId]: legacy } }),
      );
      await expect(readOwnerSearchConfig(mpId)).rejects.toThrow('配置无效');
    } finally {
      if (previousEnv === undefined)
        delete process.env.OWNER_SEARCH_CONFIG_FILE;
      else process.env.OWNER_SEARCH_CONFIG_FILE = previousEnv;
    }
  });

  it('reuses first directory and same-cookie rotation to collect ten original bodies and real image bytes once', async () => {
    (axios.get as jest.Mock).mockImplementation(async (endpoint, options) => {
      if (endpoint.endsWith('/articles'))
        return {
          status: 200,
          data: JSON.stringify(page()),
          headers: {
            'set-cookie': ['wr_skey=rotated-synthetic; Path=/; Secure'],
          },
        };
      const n = Number(options.params.reviewId.slice(-2));
      expect(options.headers.Cookie).toContain('wr_skey=rotated-synthetic');
      return { status: 200, data: html(n, n === 1), headers: {} };
    });
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
      'base64',
    );
    fetchSpy.mockResolvedValue(
      new Response(png, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    );
    const result = await validate();
    await withVerifiedWereadCandidateBinding(result, async () => true);
    const saved = await continueVerifiedWereadCandidate(result);
    expect(saved.articles).toHaveLength(10);
    expect(saved.articles[0].contentHtml).toContain(
      `data:image/png;base64,${png.toString('base64')}`,
    );
    expect(saved.articles.map((x) => x.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `WX_1234567890_${101 + i}_1`),
    );
    expect(axios.get).toHaveBeenCalledTimes(11);
    expect(
      (axios.get as jest.Mock).mock.calls.filter(([endpoint]) =>
        endpoint.endsWith('/articles'),
      ),
    ).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await fs.readFile(attemptFile(), 'utf8'))).toMatchObject({
      status: 'latest-ten-verified',
      articleIds: saved.articles.map((x) => x.id),
      response: { stage: 'content-10', httpStatus: 200 },
    });
    await expect(continueVerifiedWereadCandidate(result)).rejects.toMatchObject(
      { code: 'ATTEMPT_CONSUMED' },
    );
    expect(axios.get).toHaveBeenCalledTimes(11);
  });

  it('permits only one real group-offset next page and stops partial ten without any body', async () => {
    (axios.get as jest.Mock)
      .mockResolvedValueOnce({ status: 200, data: JSON.stringify(page(1, 3)) })
      .mockResolvedValueOnce({ status: 200, data: JSON.stringify(page(4, 2)) });
    const result = await validate();
    expect(result.selection.selected).toHaveLength(3);
    await withVerifiedWereadCandidateBinding(result, async () => true);
    await expect(continueVerifiedWereadCandidate(result)).rejects.toMatchObject(
      { code: 'COLLECTION_FAILED' },
    );
    expect((axios.get as jest.Mock).mock.calls[1][1].params).toEqual({
      bookId: mpId,
      offset: '3',
    });
    expect(axios.get).toHaveBeenCalledTimes(2);
    await expect(continueVerifiedWereadCandidate(result)).rejects.toMatchObject(
      { code: 'RETAINED_STOP' },
    );
    expect(axios.get).toHaveBeenCalledTimes(2);
  });

  it('retains a first-body business refusal without saving or fetching another body/image', async () => {
    const result = await validate();
    await withVerifiedWereadCandidateBinding(result, async () => true);
    (axios.get as jest.Mock).mockResolvedValue({
      status: 200,
      data: JSON.stringify({
        errcode: -2041,
        message: 'SYNTHETIC_SECRET_MESSAGE',
      }),
    });
    await expect(continueVerifiedWereadCandidate(result)).rejects.toMatchObject(
      { code: 'UPSTREAM_BUSINESS', businessCode: -2041 },
    );
    const state = await fs.readFile(attemptFile(), 'utf8');
    expect(JSON.parse(state).stop).toMatchObject({
      stage: 'content-1',
      requests: 2,
      reason: '业务码 -2041',
    });
    expect(state).not.toContain('SYNTHETIC_SECRET_MESSAGE');
    expect(JSON.parse(state).lastSuccessAt).toBeUndefined();
    expect(axios.get).toHaveBeenCalledTimes(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('saves a newly bound publisher through the original transaction while preserving legacy IDs/body/metrics and another publisher', async () => {
    const prisma = new PrismaClient({
      datasources: {
        db: {
          url: `file:${path.join(dir, 'provider.sqlite').replace(/\\/g, '/')}`,
        },
      },
    });
    try {
      const migrations = path.resolve(__dirname, '../../prisma/migrations');
      for (const child of (await fs.readdir(migrations)).sort()) {
        const file = path.join(migrations, child, 'migration.sql');
        try {
          for (const sql of (await fs.readFile(file, 'utf8'))
            .split(';')
            .map((x) => x.trim())
            .filter(Boolean))
            await prisma.$executeRawUnsafe(sql);
        } catch (error: any) {
          if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
        }
      }
      await prisma.feed.create({
        data: {
          id: mpId,
          mpName: name,
          collectionChannel: 'owner-weread-latest',
          mpCover: '',
          mpIntro: '',
          updateTime: 0,
        },
      });
      await prisma.feed.create({
        data: {
          id: 'MP_WXS_9999999999',
          mpName: '另一测试号',
          mpCover: '',
          mpIntro: '',
          updateTime: 0,
        },
      });
      const old = await prisma.article.create({
        data: {
          id: token(1),
          mpId,
          title: '文章1',
          publishTime: 1700000099,
          picUrl: 'protected-cover',
          contentHtml: '<div id="js_content">保护的旧正文</div>',
          readCount: 17,
          likeCount: 5,
        },
      });
      const other = await prisma.article.create({
        data: {
          id: 'other-protected',
          mpId: 'MP_WXS_9999999999',
          title: '保护的其他号文章',
          publishTime: 1700000000,
          picUrl: '',
          contentHtml: 'protected other body',
        },
      });
      (axios.get as jest.Mock).mockImplementation(
        async (endpoint, options) => ({
          status: 200,
          data: endpoint.endsWith('/articles')
            ? JSON.stringify(page())
            : html(Number(options.params.reviewId.slice(-2))),
          headers: {},
        }),
      );
      const result = await validate();
      await withVerifiedWereadCandidateBinding(result, async () => true);
      const service = new CollectionService(prisma as any);
      const saved = await service.collectVerifiedWereadCandidate(result);
      expect(saved).toMatchObject({
        articles: 10,
        created: 9,
        updated: 1,
        coverage: 'recent-window',
        complete: false,
      });
      expect(createVerifiedSqliteBackup).toHaveBeenCalledTimes(1);
      expect(await prisma.article.count({ where: { mpId } })).toBe(10);
      expect(
        await prisma.article.findUniqueOrThrow({ where: { id: old.id } }),
      ).toMatchObject({
        id: old.id,
        title: old.title,
        publishTime: old.publishTime,
        picUrl: old.picUrl,
        contentHtml: old.contentHtml,
        readCount: old.readCount,
        likeCount: old.likeCount,
      });
      expect(
        await prisma.article.findUniqueOrThrow({ where: { id: other.id } }),
      ).toEqual(other);
      await expect(
        service.collectVerifiedWereadCandidate(result),
      ).rejects.toMatchObject({ code: 'ATTEMPT_CONSUMED' });
      expect(axios.get).toHaveBeenCalledTimes(11);
    } finally {
      await prisma.$disconnect();
    }
  });
});
