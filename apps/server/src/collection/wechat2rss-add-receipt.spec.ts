import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { wechat2RssAddReceipt } from './wechat2rss-add-receipt';

describe('durable Wechat2RSS one-shot claim', () => {
  let root: string, database: string;
  const url = 'https://mp.weixin.qq.com/s/synthetic?z=1&a=2';
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-add-receipt-'));
    database = path.join(root, 'fixture.db');
    await fs.writeFile(database, 'synthetic-file');
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  it('persists the claim and safe accepted path across restarts with a private backup', async () => {
    const backup = path.join(root, 'backups', 'before', 'fixture.db');
    const first = await wechat2RssAddReceipt(database, url, backup);
    expect(first.receipt).toBeUndefined();
    await first.claim();
    const restarted = await wechat2RssAddReceipt(database, url);
    expect(restarted.receipt).toEqual({ version: 1 });
    await expect(restarted.claim()).rejects.toMatchObject({ code: 'EEXIST' });
    await first.accepted('/feed/synthetic-encrypted.xml');
    expect((await wechat2RssAddReceipt(database, url)).receipt).toEqual({
      version: 1,
      feedPath: '/feed/synthetic-encrypted.xml',
    });
    const saved = await fs.readdir(path.join(root, '.wechat2rss-add'));
    expect(saved).toHaveLength(1);
    const raw = await fs.readFile(
      path.join(root, '.wechat2rss-add', saved[0]),
      'utf8',
    );
    expect(raw).not.toMatch(/mp\.weixin|https:|token|synthetic\?/);
    expect(
      await fs.readFile(
        path.join(path.dirname(backup), '.wechat2rss-add', saved[0]),
        'utf8',
      ),
    ).toBe(raw);
  });
  it('query order and fragment do not create a second claim', async () => {
    await (await wechat2RssAddReceipt(database, url)).claim();
    const other = await wechat2RssAddReceipt(
      database,
      'https://mp.weixin.qq.com/s/synthetic?a=2&z=1#top',
    );
    expect(other.receipt).toEqual({ version: 1 });
    await expect(other.claim()).rejects.toMatchObject({ code: 'EEXIST' });
  });
  it('rejects corrupted or oversized claims rather than silently replaying them', async () => {
    await (await wechat2RssAddReceipt(database, url)).claim();
    const dir = path.join(root, '.wechat2rss-add'),
      file = path.join(dir, (await fs.readdir(dir))[0]);
    for (const contents of [
      '',
      '{"version":2}',
      '{"version":1,"feedPath":"/login/new"}',
      'x'.repeat(1025),
    ]) {
      await fs.writeFile(file, contents);
      await expect(wechat2RssAddReceipt(database, url)).rejects.toThrow();
    }
  });
  it('does not persist a query, external URL, traversal or non-feed path', async () => {
    const receipt = await wechat2RssAddReceipt(database, url);
    await receipt.claim();
    for (const value of [
      '/feed/id.xml?k=secret',
      'https://example.com/feed/id.xml',
      '/feed/../config.xml',
      '/add/id',
    ])
      await expect(receipt.accepted(value)).rejects.toThrow(
        'WECHAT2RSS_RECEIPT_INVALID',
      );
    expect((await wechat2RssAddReceipt(database, url)).receipt).toEqual({
      version: 1,
    });
  });
});
