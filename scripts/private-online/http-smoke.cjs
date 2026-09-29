const assert = require('node:assert/strict');
const fs = require('node:fs/promises');

async function main() {
  const [base, feedId, destination] = process.argv.slice(2);
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(feedId, /^MP_WXS_\d{5,15}$/);
  assert.ok(destination.includes('output/subscription-implementation'));
  const routes = [
    '/feeds/all.atom',
    '/proxy/image?url=x',
    `/download/feed/${feedId}.zip`,
    '/trpc/feed.list',
  ];
  for (const route of routes) {
    const response = await fetch(base + route, { redirect: 'manual' });
    assert.equal(response.status, 401, `anonymous ${route}`);
  }
  const page = await fetch(base + '/dash/feeds/' + feedId, {
    redirect: 'manual',
  });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/dash/login');
  const root = await fetch(base + '/', { redirect: 'manual' });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/dash/login');
  const denied = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'invalid' }),
  });
  assert.equal(denied.status, 401);
  const login = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: process.env.SMOKE_AUTH_CODE }),
  });
  assert.equal(login.status, 204);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.match(cookie, /^wewe_private_session=/);
  const headers = { cookie };
  const feed = await fetch(base + '/feeds/all.atom', { headers });
  assert.equal(feed.status, 200);
  assert.match(feed.headers.get('content-type'), /xml/);
  const legacyAccount = await fetch(
    base + '/trpc/account.byId?input=%22legacy-account%22',
    { headers },
  );
  assert.equal(legacyAccount.status, 403);
  const download = await fetch(base + `/download/feed/${feedId}.zip`, {
    headers,
  });
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /attachment;/);
  assert.match(download.headers.get('content-type'), /application\/zip/);
  const bytes = Buffer.from(await download.arrayBuffer());
  assert.equal(bytes.subarray(0, 4).toString('hex'), '504b0304');
  await fs.writeFile(destination, bytes);
  console.log(
    JSON.stringify({
      anonymousProtected: routes.length + 2,
      legacyAccountBlocked: legacyAccount.status,
      feed: feed.status,
      zipBytes: bytes.length,
    }),
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
