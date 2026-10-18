import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

type Receipt = { version: 1; feedPath?: string };

/** A durable one-shot claim: crashes and uncertain responses must not replay /addurl. */
export async function wechat2RssAddReceipt(
  database: string,
  articleUrl: string,
  backupFile?: string,
) {
  const directory = path.join(
    path.dirname(await fs.realpath(database)),
    '.wechat2rss-add',
  );
  await fs.mkdir(directory, { recursive: true });
  if ((await fs.realpath(directory)) !== directory)
    throw new Error('WECHAT2RSS_RECEIPT_INVALID');
  const link = new URL(articleUrl);
  link.hash = '';
  link.searchParams.sort();
  const key = createHash('sha256').update(link.toString()).digest('hex');
  const file = path.join(directory, key + '.json');
  const snapshot = async () => {
    if (!backupFile) return;
    const target = path.join(path.dirname(backupFile), '.wechat2rss-add');
    await fs.mkdir(target, { recursive: true });
    await fs.copyFile(file, path.join(target, path.basename(file)));
  };
  let receipt: Receipt | undefined;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024)
      throw new Error('WECHAT2RSS_RECEIPT_INVALID');
    receipt = JSON.parse(await fs.readFile(file, 'utf8'));
    if (
      receipt?.version !== 1 ||
      (receipt.feedPath !== undefined &&
        !/^\/feed\/[A-Za-z0-9_-]+\.(xml|json)$/.test(receipt.feedPath))
    )
      throw new Error('WECHAT2RSS_RECEIPT_INVALID');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return {
    receipt,
    async claim() {
      const handle = await fs.open(file, 'wx');
      try {
        await handle.writeFile(JSON.stringify({ version: 1 }));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await snapshot();
    },
    async accepted(feedPath: string) {
      if (!/^\/feed\/[A-Za-z0-9_-]+\.(xml|json)$/.test(feedPath))
        throw new Error('WECHAT2RSS_RECEIPT_INVALID');
      const temporary = file + '.' + randomUUID() + '.tmp';
      try {
        await fs.writeFile(
          temporary,
          JSON.stringify({ version: 1, feedPath }),
          { flag: 'wx' },
        );
        await fs.rename(temporary, file);
        await snapshot();
      } finally {
        await fs.rm(temporary, { force: true });
      }
    },
  };
}
