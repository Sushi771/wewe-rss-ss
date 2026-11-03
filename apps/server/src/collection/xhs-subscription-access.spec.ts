import {
  RedbookSubscriptionAdapter,
  XhsProfileParser,
} from './xhs-redbook-subscription';
import { RedbookClient } from './redbook-client';
import { XhsShortLinkResolver } from './xhs-short-link';

const author = {
  id: 'synthetic-author',
  name: 'Verified synthetic author',
  profileUrl: 'https://www.xiaohongshu.com/user/profile/synthetic-author',
};
// Explicit synthetic schema: this is not a claim about live otherinfo responses.
const parser: XhsProfileParser = (raw: any, expected) => {
  if (raw.schema !== 'synthetic-reviewed' || raw.author.id !== expected)
    throw Error('unrecognized');
  return raw.author;
};
const card = (noteId: string) => ({
  items: [
    {
      id: noteId,
      note_card: {
        note_id: noteId,
        user: { user_id: author.id, nickname: author.name },
        title: 'Synthetic',
        desc: 'Synthetic body',
        type: 'normal',
        time: 1760000000000,
        image_list: [],
      },
    },
  ],
});
const client = () => ({
  getUserInfo: jest.fn(async () => ({ schema: 'synthetic-reviewed', author })),
  getUserNotes: jest.fn(async () => ({
    notes: [],
    cursor: '',
    has_more: false,
  })),
  getNoteById: jest.fn(async (noteId: string) => card(noteId)),
});

describe('verified read endpoint and private access context (synthetic only)', () => {
  it('uses the pinned getUserInfo endpoint and retains sanitized failures with zero retries', async () => {
    const transport = jest.fn(
      async (request): Promise<any> => ({
        status: 200,
        url: request.url,
        body: {
          success: true,
          code: 0,
          data: { schema: 'synthetic-reviewed', author },
        },
      }),
    );
    const api = new RedbookClient({
      transport,
      cookies: () => ({ a1: 'synthetic-a1', web_session: 'synthetic-session' }),
    });
    expect(
      await api.getUserInfo(author.id, {
        xsecToken: 'synthetic-profile-token',
        xsecSource: 'pc_search',
      }),
    ).toEqual({ schema: 'synthetic-reviewed', author });
    const request = transport.mock.calls[0][0];
    const url = new URL(request.url);
    expect(url.pathname).toBe('/api/sns/web/v1/user/otherinfo');
    expect(request.method).toBe('GET');
    expect(request.redirect).toBe('error');
    expect(url.searchParams.get('target_user_id')).toBe(author.id);
    expect(url.searchParams.get('xsec_source')).toBe('pc_search');
    transport.mockImplementation(async (request) => ({
      status: 471,
      url: request.url,
      body: { raw: 'synthetic-secret-not-for-errors' },
    }));
    await expect(api.getUserInfo(author.id)).rejects.toThrow(
      'unknown_rejection',
    );
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it('classifies malformed list data without exposing its body or retrying',async()=>{
    const api=client();api.getUserNotes.mockResolvedValueOnce({notes:'synthetic-private-payload',cursor:'',has_more:false} as any);
    const adapter=new RedbookSubscriptionAdapter(api,{profileParser:parser});adapter.restoreDefaultAuthorAccess(author.id);
    await expect(adapter.list(author.id,null)).rejects.toMatchObject({code:'XHS_LIST_PARSE_FAILED',message:'XHS_LIST_PARSE_FAILED'});
    expect(api.getUserNotes).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['missing', [{}]], ['invalid', [{user_id:'bad id'}]],
    ['mismatch', [{user_id:'other-author'}]], ['mixed', [{user_id:author.id},{user_id:'other-author'}]],
  ])('does not classify a malformed list with %s author identity as a local parse failure',async(_label,users)=>{
    const api=client();api.getUserNotes.mockResolvedValueOnce({notes:users.map((user,i)=>({note_id:`note${i}`,user,xsec_token:'synthetic'})),cursor:'',has_more:'invalid'} as any);
    const adapter=new RedbookSubscriptionAdapter(api,{profileParser:parser});adapter.restoreDefaultAuthorAccess(author.id);
    await expect(adapter.list(author.id,null)).rejects.not.toMatchObject({code:'XHS_LIST_PARSE_FAILED'});expect(api.getUserNotes).toHaveBeenCalledTimes(1);
  });
  it('classifies a returned malformed detail locally without exposing body',async()=>{
    const api=client();api.getUserNotes.mockResolvedValueOnce({notes:[{note_id:'synthetic',user:{user_id:author.id},xsec_token:'synthetic'}],cursor:'',has_more:false} as any);api.getNoteById.mockResolvedValueOnce({items:[{id:'synthetic',note_card:{note_id:'synthetic',user:{user_id:author.id},type:'synthetic-private-body'}}]} as any);
    const adapter=new RedbookSubscriptionAdapter(api,{profileParser:parser});adapter.restoreDefaultAuthorAccess(author.id);await adapter.list(author.id,null);
    await expect(adapter.basicDetail(author.id,'synthetic')).rejects.toMatchObject({code:'XHS_DETAIL_PARSE_FAILED',message:'XHS_DETAIL_PARSE_FAILED'});expect(api.getNoteById).toHaveBeenCalledTimes(1);
  });
  it('does not dispatch an already cancelled request', async () => {
    const transport = jest.fn();
    const api = new RedbookClient({
      transport,
      cookies: () => ({ a1: 'synthetic', web_session: 'synthetic' }),
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      api.getUserNotes(author.id, '', { signal: controller.signal }),
    ).rejects.toThrow('XHS_LOCAL_PRE_DISPATCH_FAILED');
    expect(transport).not.toHaveBeenCalled();
  });
  it('requires a reviewed profile parser and never guesses a name', async () => {
    const api = client();
    await expect(
      new RedbookSubscriptionAdapter(api).resolve(author.profileUrl),
    ).rejects.toThrow('XHS_PROFILE_SCHEMA_UNRECOGNIZED');
    expect(api.getNoteById).not.toHaveBeenCalled();
    await expect(
      new RedbookSubscriptionAdapter(api, {
        profileParser: () => ({ ...author, id: 'foreign' }),
      }).resolve(author.profileUrl),
    ).rejects.toThrow('XHS_AUTHOR_MISMATCH');
  });
  it('retains profile token/source privately for list requests and keeps dates unknown', async () => {
    const api = client();
    const adapter = new RedbookSubscriptionAdapter(api, {
      profileParser: parser,
    });
    const resolution = await adapter.resolve(
      author.profileUrl +
        '?xsec_token=synthetic-profile-token&xsec_source=pc_search',
    );
    await adapter.list(author.id, null);
    expect(api.getUserInfo).toHaveBeenCalledWith(author.id, {
      xsecToken: 'synthetic-profile-token',
      xsecSource: 'pc_search',
    });
    expect(api.getUserNotes).toHaveBeenCalledWith(author.id, '', {
      xsecToken: 'synthetic-profile-token',
      xsecSource: 'pc_search',
    });
    expect(JSON.stringify(resolution)).not.toContain('synthetic-profile-token');
  });
  it('reuses strictly bound note user identity/name without requesting profile or media', async () => {
    const api = client();
    const media = jest.fn();
    const adapter = new RedbookSubscriptionAdapter(api, {}, media);
    expect(
      await adapter.resolve(
        'https://www.xiaohongshu.com/explore/note-a?xsec_token=synthetic-note-token&xsec_source=app_share',
      ),
    ).toEqual({ inputKind: 'note', author });
    expect(api.getUserInfo).not.toHaveBeenCalled();
    expect(media).not.toHaveBeenCalled();
    expect(api.getNoteById).toHaveBeenCalledWith(
      'note-a',
      'synthetic-note-token',
      'app_share',
    );
    await adapter.list(author.id, null);
    expect(api.getUserNotes).toHaveBeenCalledWith(author.id, '', {
      xsecToken: '',
      xsecSource: '',
    });
  });
  it('does not evict early page access at 3000 entries; invalid dates are not invented', async () => {
    const api = client();
    (api.getUserNotes as jest.Mock).mockImplementation(
      async (_author, cursor) => {
        const offset = Number(cursor || 0);
        return {
          notes: Array.from({ length: 30 }, (_, i) => ({
            note_id: `note-${offset + i}`,
            user: { user_id: author.id },
            xsec_token: `synthetic-${offset + i}`,
            display_title: '',
            time: 'unknown',
          })),
          cursor: String(offset + 30),
          has_more: true,
        };
      },
    );
    const adapter = new RedbookSubscriptionAdapter(api, {
      profileParser: parser,
    });
    await adapter.resolve(author.profileUrl);
    for (let i = 0; i < 101; i++)
      expect(
        (await adapter.list(author.id, String(i * 30))).notes[0].publishedAt,
      ).toBe(0);
    expect((await adapter.detail(author.id, 'note-0')).noteId).toBe('note-0');
    expect(api.getNoteById).toHaveBeenLastCalledWith(
      'note-0',
      'synthetic-0',
      'pc_user',
      undefined,
    );
  });
  it('blocks expired private context without acquiring a different account or rescanning', async () => {
    const api = client();
    let now = 0;
    const adapter = new RedbookSubscriptionAdapter(api, {
      profileParser: parser,
      now: () => now,
      contextLifetimeMs: 100,
    });
    await adapter.resolve(author.profileUrl);
    now = 101;
    await expect(adapter.list(author.id, null)).rejects.toThrow(
      'XHS_ACCESS_CONTEXT_EXPIRED',
    );
    await expect(adapter.detail(author.id, 'old-note')).rejects.toThrow(
      'XHS_ACCESS_CONTEXT_EXPIRED',
    );
    expect(api.getUserNotes).not.toHaveBeenCalled();
    expect(api.getNoteById).not.toHaveBeenCalled();
  });
});

describe('restricted cookie-free short-link resolution (synthetic redirects only)', () => {
  it('inspects every redirect and retains the final signed link only in private parsing', async () => {
    const transport = jest.fn(async (url: URL) => ({
      status: 302,
      url: url.href,
      location:
        url.pathname === '/a/one'
          ? '/a/two'
          : author.profileUrl +
            '?xsec_token=synthetic-profile-token&xsec_source=app_share',
    }));
    const resolver = new XhsShortLinkResolver(transport);
    const api = client();
    const adapter = new RedbookSubscriptionAdapter(api, {
      profileParser: parser,
      shortLinks: resolver,
    });
    expect(await adapter.resolve('https://xhslink.com/a/one')).toEqual({
      inputKind: 'profile',
      author,
    });
    expect(transport).toHaveBeenCalledTimes(2);
    expect((transport.mock.calls[0] as any)[1]).toMatchObject({
      redirect: 'manual',
      credentials: 'omit',
      headers: { accept: 'text/html' },
    });
    expect((transport.mock.calls[0] as any)[1].headers).not.toHaveProperty(
      'cookie',
    );
  });
  it.each([
    'http://127.0.0.1/private',
    'https://127.0.0.1/private',
    'https://evil.test/explore/a',
    'https://www.xiaohongshu.com:443/explore/a',
    'https://user@www.xiaohongshu.com/explore/a',
  ])('rejects redirect target %s without requesting it', async (location) => {
    const transport = jest.fn(async (url: URL) => ({
      status: 302,
      url: url.href,
      location,
    }));
    await expect(
      new XhsShortLinkResolver(transport).resolve('https://xhslink.com/a/one'),
    ).rejects.toThrow('XHS_SHORT_LINK_REJECTED');
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('rejects loops, excessive chains, automatic redirects and unrecognized HTML rather than executing script', async () => {
    const transport = jest.fn(async (url: URL) => ({
      status: 302,
      url: url.href,
      location: '/a/one',
    }));
    await expect(
      new XhsShortLinkResolver(transport).resolve('https://xhslink.com/a/one'),
    ).rejects.toThrow('XHS_SHORT_LINK_REJECTED');
    expect(transport).toHaveBeenCalledTimes(1);
    transport.mockImplementation(
      async (url) => ({ status: 200, url: url.href, location: null }) as any,
    );
    await expect(
      new XhsShortLinkResolver(transport).resolve('https://xhslink.com/a/one'),
    ).rejects.toThrow('XHS_SHORT_LINK_REJECTED');
    transport.mockImplementation(async () => ({
      status: 302,
      url: 'https://evil.test',
      location: author.profileUrl,
    }));
    await expect(
      new XhsShortLinkResolver(transport).resolve('https://xhslink.com/a/one'),
    ).rejects.toThrow('XHS_SHORT_LINK_REJECTED');
  });
});
