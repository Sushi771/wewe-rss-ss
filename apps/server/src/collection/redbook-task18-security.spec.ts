import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request } from 'express';
import { createHash } from 'node:crypto';
import { redbookLocalAccess, redbookHandoffPath } from './redbook-local-access';
import { reviewRedbookBinding } from './redbook-evidence';
import { RedbookRuntime } from './redbook-runtime';
import { REDBOOK_RESPONSE_CONTRACT } from './redbook-response';

const auth = 'synthetic-task18-auth';
function req(
  headers: Record<string, string> = {},
  remoteAddress = '127.0.0.1',
) {
  const all = {
    authorization: auth,
    origin: 'http://localhost',
    host: 'localhost',
    ...headers,
  };
  return {
    headers: all,
    socket: { remoteAddress },
    protocol: 'http',
    get: (name: string) => all[name],
  } as unknown as Request;
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
function evidence() {
  return {
    creatorId: 'synthetic-local',
    authorId: 'synthetic-author',
    profileUrl: 'https://www.xiaohongshu.com/user/profile/synthetic-author',
    review: {
      contract: REDBOOK_RESPONSE_CONTRACT as typeof REDBOOK_RESPONSE_CONTRACT,
      reviewedAt: Date.now(),
      authorIdentityChecked: true as const,
      fullTextChecked: true as const,
      allImagesChecked: true as const,
      publicationTimeChecked: true as const,
      noteId: 'synthetic-note',
      publishedAt: 1700000000,
      textSha256: sha('synthetic whole caption'),
      imageUrlSha256s: [],
      list: {
        notes: [
          {
            note_id: 'synthetic-note',
            user: { user_id: 'synthetic-author' },
            xsec_token: 'synthetic-token',
          },
        ],
        cursor: '',
        has_more: false,
      },
      detail: {
        items: [
          {
            id: 'synthetic-note',
            note_card: {
              note_id: 'synthetic-note',
              user: { user_id: 'synthetic-author' },
              type: 'normal',
              time: 1700000000000,
              title: 'synthetic',
              desc: 'synthetic whole caption',
              image_list: [],
            },
          },
        ],
      },
    },
  };
}

describe('task18 independent private handoff boundary (synthetic, no transport)', () => {
  it('allows only authenticated direct same-origin loopback', () => {
    expect(redbookLocalAccess(req(), auth)).toBe(true);
    expect(redbookLocalAccess(req(), undefined)).toBe(false);
    expect(redbookLocalAccess(req({ authorization: 'wrong' }), auth)).toBe(
      false,
    );
    expect(redbookLocalAccess(req({}, '203.0.113.1'), auth)).toBe(false);
    expect(redbookLocalAccess(req({ origin: 'https://evil.test' }), auth)).toBe(
      false,
    );
  });
  it.each([
    'forwarded',
    'via',
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-proto',
    'x-forwarded-port',
    'x-forwarded-path',
    'x-forwarded-prefix',
  ])('rejects forwarding header %s', (header) => {
    expect(redbookLocalAccess(req({ [header]: 'synthetic' }), auth)).toBe(
      false,
    );
  });
  it.each([
    'evil@localhost',
    'localhost/path',
    'localhost?ignored',
    'localhost#ignored',
  ])('rejects non-Host URL component %s', (host) => {
    expect(redbookLocalAccess(req({ host }), auth)).toBe(false);
  });
  it.each([
    '/local/redbook/session/',
    '/local/redbook/session/extra',
    '/local/redbook/publish',
    '/local/redbook/comment',
    '/local/redbook/session?cookie=synthetic',
  ])('never gives special private-route bypass to %s', (route) => {
    expect(redbookHandoffPath(route)).toBe(false);
  });
  it('keeps default production runtime disabled and status secret-free', () => {
    const runtime = new RedbookRuntime({} as any);
    expect(runtime.status()).toEqual({
      configured: false,
      expiresAt: null,
      bindingCount: 0,
      reviewBasis: null,
      platformVerified: false,
      liveValidation: 'pending',
    });
    expect(JSON.stringify(runtime.status())).not.toMatch(
      /cookies|web_session|a1/,
    );
  });
  it('records operator evidence while never asserting platform verification', () => {
    expect(reviewRedbookBinding(evidence()).reviewBasis).toBe(
      'operator-supplied-evidence',
    );
  });
  it.each([
    'list-author',
    'detail-author',
    'note',
    'profile',
    'text',
    'time',
    'review-age',
    'missing-review',
  ])('rejects independent first-binding mismatch: %s', (kind) => {
    const value = evidence();
    if (kind === 'list-author')
      value.review.list.notes[0].user.user_id = 'other';
    if (kind === 'detail-author')
      value.review.detail.items[0].note_card.user.user_id = 'other';
    if (kind === 'note') value.review.noteId = 'other';
    if (kind === 'profile') value.profileUrl += '?alias=other';
    if (kind === 'text') value.review.textSha256 = '0'.repeat(64);
    if (kind === 'time') value.review.publishedAt++;
    if (kind === 'review-age') value.review.reviewedAt -= 8 * 86400000;
    if (kind === 'missing-review') delete (value as any).review;
    expect(() => reviewRedbookBinding(value)).toThrow();
  });
});

describe('task18 independent runtime lifecycle (no database, no network)', () => {
  const oldDatabase = process.env.DATABASE_URL;
  let runtime: RedbookRuntime;
  beforeEach(() => {
    process.env.DATABASE_URL =
      'file:' +
      join(tmpdir(), 'redbook-task18-no-network', 'synthetic.sqlite').replace(
        /\\/g,
        '/',
      );
    runtime = new RedbookRuntime({
      xhsCreator: {
        findUnique: async () => ({
          id: 'synthetic-local',
          profileUrl: evidence().profileUrl,
          externalAuthorId: null,
        }),
        findFirst: async () => null,
      },
    } as any);
  });
  afterEach(async () => {
    await runtime.onModuleDestroy();
    if (oldDatabase === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = oldDatabase;
  });
  const input = () => ({
    cookies: {
      a1: 'synthetic-task18-a1',
      web_session: 'synthetic-task18-session',
    },
    expiresAt: Date.now() + 60000,
    bindings: [evidence()],
  });
  it('installs without disclosing credentials and revoke drops private memory', async () => {
    const result = await runtime.install(input());
    expect(result.configured).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(
      /synthetic-task18|cookies|web_session/,
    );
    const privateSession = (runtime as any).session;
    await runtime.revoke();
    expect(privateSession.abort.signal.aborted).toBe(true);
    expect(privateSession.cookies).toEqual({});
    expect(runtime.status().configured).toBe(false);
  });
  it.each([
    'missing-a1',
    'missing-session',
    'crlf',
    'semicolon',
    'expired',
    'over-ttl',
    'arbitrary-host',
    'duplicate-author',
    'arbitrary-id',
  ])('rejects %s before a session exists', async (kind) => {
    const value: any = input();
    if (kind === 'missing-a1') delete value.cookies.a1;
    if (kind === 'missing-session') delete value.cookies.web_session;
    if (kind === 'crlf') value.cookies.a1 += '\r\nInjected: yes';
    if (kind === 'semicolon') value.cookies.a1 += ';other=value';
    if (kind === 'expired') value.expiresAt = Date.now() - 1;
    if (kind === 'over-ttl') value.expiresAt = Date.now() + 3 * 3600000;
    if (kind === 'arbitrary-host') value.host = 'http://evil.test';
    if (kind === 'duplicate-author') value.bindings.push(evidence());
    if (kind === 'arbitrary-id')
      value.bindings = [{ creatorId: 'synthetic-local', authorId: 'any-id' }];
    await expect(runtime.install(value)).rejects.toThrow();
    expect(runtime.configured).toBe(false);
  });
  it('refuses changed local profile before any source dispatch', async () => {
    await runtime.install(input());
    const result = await runtime.scan(
      {
        id: 'synthetic-local',
        profileUrl: 'https://www.xiaohongshu.com/user/profile/other',
        externalAuthorId: null,
      } as any,
      async () => {
        throw Error('UNEXPECTED_COMMIT');
      },
    );
    expect(result.status).toBe('paused');
  });
});
