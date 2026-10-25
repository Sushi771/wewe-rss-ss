import * as assert from 'node:assert/strict';
import { XhsShortLinkResolver, xhsPublicInputUrl } from './xhs-short-link';
import { RedbookSubscriptionAdapter } from './xhs-redbook-subscription';
import { XhsSubscriptionService } from './xhs-subscription.service';
it('keeps official short links bounded and cookie-free while rejecting unsafe redirects and mismatched note identity', async () => { let cases = 0; const final = 'https://www.xiaohongshu.com/explore/' + 'a'.repeat(24) + '?xsec_token=synthetic-private&xsec_source=pc_share'; for (const u of ['https://xhslink.cn/o/Synthetic', 'https://xhslink.com/a/Synthetic']) {
    let calls = 0;
    const r = new XhsShortLinkResolver(async (url, o) => { calls++; assert.equal(o.redirect, 'manual'); assert.equal(o.credentials, 'omit'); assert.deepEqual(o.headers, { accept: 'text/html' }); return { status: 302, url: url.href, location: final }; });
    assert.equal((await r.resolve(u)).href, final);
    assert.equal(calls, 1);
    cases++;
} for (const u of ['http://xhslink.cn/o/a', 'https://xhslink.cn.evil.test/o/a', 'https://xhslink.cn@evil.test/o/a', 'https://xhslink.cn:443/o/a', 'https://xhslink.cn/a/a', 'https://xhslink.cn/o/a?token=x', 'https://xhslink.cn/o/%2fadmin', 'https://127.0.0.1/o/a', 'https://xhslink.cn./o/a']) {
    assert.throws(() => xhsPublicInputUrl(u));
    cases++;
} for (const loc of ['http://127.0.0.1/a', 'https://10.0.0.1/a', 'https://www.xiaohongshu.com/login', 'https://passport.xiaohongshu.com/login', 'https://evil.test/a', 'https://www.xiaohongshu.com:443/explore/a', 'https://xhslink.cn.evil.test/o/a']) {
    let calls = 0;
    const r = new XhsShortLinkResolver(async (url) => { calls++; return { status: 302, url: url.href, location: loc }; });
    await assert.rejects(r.resolve('https://xhslink.cn/o/a'));
    assert.equal(calls, 1);
    cases++;
} let hops = 0; await assert.rejects(new XhsShortLinkResolver(async (u) => ({ status: 302, url: u.href, location: 'https://xhslink.cn/o/h' + ++hops })).resolve('https://xhslink.cn/o/start')); assert.equal(hops, 5); cases++; let retry = 0; await assert.rejects(new XhsShortLinkResolver(async () => { retry++; throw Error('xsec_token=synthetic-private'); }).resolve('https://xhslink.cn/o/a'), (e: unknown) => e instanceof Error && !e.message.includes('synthetic-private')); assert.equal(retry, 1); cases++; let loop = 0; await assert.rejects(new XhsShortLinkResolver(async (u) => { loop++; return { status: 302, url: u.href, location: u.href }; }).resolve('https://xhslink.cn/o/a')); assert.equal(loop, 1); cases++; const author = { id: 'same-author', name: 'Synthetic', profileUrl: 'https://www.xiaohongshu.com/user/profile/same-author' }; const source = { resolve: async () => ({ inputKind: 'profile', author }) }; const svc = new XhsSubscriptionService({ xhsCreator: { findFirst: async () => null } } as any, source as any); const resolved = await svc.resolveSubscription({ url: 'https://xhslink.cn/o/profile' }); assert.equal(resolved.author.id, 'same-author'); cases++; const adapter = new RedbookSubscriptionAdapter({ getNoteById: async () => ({ items: [{ id: 'b'.repeat(24), note_card: { note_id: 'b'.repeat(24), user: { user_id: 'wrong-author', nickname: 'Synthetic' } } }] }), getUserInfo: async () => { }, getUserNotes: async () => { } } as any, { shortLinks: new XhsShortLinkResolver(async (u) => ({ status: 302, url: u.href, location: final })) }); await assert.rejects(adapter.resolve('https://xhslink.cn/o/a')); cases++; expect(cases).toBe(23); });
