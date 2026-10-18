import { PrismaClient } from '@prisma/client';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readCachedBodyMediaFlags } from './cache-body-media-flags';
import { legacyCachedFlags } from '../../test/fixtures/legacy-cache-body-flags';

describe('bounded linear cache body media flags', () => {
  let root: string, prisma: PrismaClient;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cache-flags-synthetic-'));
    prisma = new PrismaClient({
      datasources: {
        db: {
          url: 'file:' + path.join(root, 'flags.db') + '?connection_limit=1',
        },
      },
    });
    await prisma.$executeRawUnsafe(
      'CREATE TABLE articles (id TEXT PRIMARY KEY, mp_id TEXT, content_html TEXT)',
    );
  });
  afterEach(async () => {
    await prisma.$disconnect();
    if (
      path.dirname(root) === os.tmpdir() &&
      path.basename(root).startsWith('cache-flags-synthetic-')
    )
      await fs.rm(root, { recursive: true, force: true });
  });
  const put = (id: string, html: string | null, feed = 'feed') =>
    prisma.$executeRaw`INSERT INTO articles VALUES(${id},${feed},${html})`;
  it('matches the frozen predicate for quote order, case, malformed tags, inline/data-src and markers', async () => {
    const cases = [
      null,
      '',
      '<p>text</p>',
      '<img>',
      '<img src="https://mmbiz.qpic.cn/a">',
      "<img data-src='http://cdn/a'>",
      '<IMG ALT="x" SRC="HTTP://cdn/a">',
      '<img data-src="http://cdn/a" src="data:image/png;base64,AA==">',
      "<img src='data:image/png;base64,AA==' data-src='https://cdn/a'>",
      '<p> src="https://not-an-image"</p>',
      '<img src="data:image/png;base64,AA=="><img data-src="https://cdn/a">',
      '<img data-src="https://cdn/a"',
      '<img src=data:image/png><img src="http://cdn/a">',
      '<img\nsrc="http://cdn/a">',
      '<div data-wewe-image-pending="2">text</div>',
      "<div data-wewe-image-retryable='true'>text</div>",
      '<div data-wewe-image-retryable="true" data-wewe-image-pending="1"> src="http://body-text"</div>',
      '<div>literal <img alt=" src=\'http://inside-alt\'" src="data:image/png"></div>',
      '<img src="data:image/png;base64,AA==" alt=" data-src=\'http://inside-alt\'">',
    ];
    for (const [n, html] of cases.entries()) await put(String(n), html);
    const normalize = (rows: any[]) =>
      rows
        .map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [
              key,
              typeof value === 'bigint' ? Number(value) : value,
            ]),
          ),
        )
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    expect(
      normalize(
        await readCachedBodyMediaFlags(
          prisma,
          'feed',
          cases.map((_, n) => String(n)),
        ),
      ),
    ).toEqual(normalize(await legacyCachedFlags(prisma, 'feed')));
  });
  it('scopes to exact saved page IDs and never returns another feed or old page', async () => {
    await put('current', '<p>body</p>');
    await put('old', '<img src="http://old">');
    await put('foreign', '<img>', 'other');
    expect(
      await readCachedBodyMediaFlags(prisma, 'feed', [
        'current',
        'current',
        'foreign',
        'missing',
      ]),
    ).toEqual([
      { id: 'current', bodyMissing: 0, remoteImages: 0, mediaPending: 0 },
    ]);
  });
  it('transfers no HTML for healthy large inline content and uses one statement without a transaction', async () => {
    await put(
      'inline',
      '<img src="data:image/png;base64,' + 'A'.repeat(2_000_000) + '">',
    );
    const raw = jest.spyOn(prisma, '$queryRaw'),
      tx = jest.spyOn(prisma, '$transaction');
    expect(await readCachedBodyMediaFlags(prisma, 'feed', ['inline'])).toEqual([
      { id: 'inline', bodyMissing: 0, remoteImages: 0, mediaPending: 0 },
    ]);
    const result = await raw.mock.results[0].value;
    expect(result[0].probe).toBeNull();
    expect(raw).toHaveBeenCalledTimes(1);
    expect(tx).not.toHaveBeenCalled();
  });
  it('keeps oversized or total-budget-deferred probes pending rather than falsely complete', async () => {
    const html =
      '<img src="data:image/png;base64,' +
      'A'.repeat(4_100_000) +
      '" data-src="https://cdn/a">';
    await put('a', html);
    await put('b', html);
    await put('c', 'X'.repeat(8_000_001));
    const rows = await readCachedBodyMediaFlags(prisma, 'feed', [
      'a',
      'b',
      'c',
    ]);
    expect(rows.find((row) => row.id === 'a')!.mediaPending).toBe(0);
    expect(rows.find((row) => row.id === 'b')!.mediaPending).toBe(1);
    expect(rows.find((row) => row.id === 'c')!.mediaPending).toBe(1);
  });
  it('stops after an unclosed tag without regex backtracking across repeated openers', async () => {
    await put('broken', '<img '.repeat(50_000) + ' data-src="http://cdn/a"');
    const start = performance.now();
    expect(await readCachedBodyMediaFlags(prisma, 'feed', ['broken'])).toEqual([
      { id: 'broken', bodyMissing: 0, remoteImages: 0, mediaPending: 0 },
    ]);
    expect(performance.now() - start).toBeLessThan(2500);
  });
});
