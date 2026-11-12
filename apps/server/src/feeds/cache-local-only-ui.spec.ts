import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { CacheMediaPause } from './cache-sync-state';

it('explains local-only text and image limitations even without a media queue row', () => {
  const pause: CacheMediaPause = 'local-cache-only';
  const source = readFileSync(
    path.resolve(
      __dirname,
      '../../../web/src/pages/feeds/cache-sync-status.tsx',
    ),
    'utf8',
  );
  expect(source).toContain(`pause !== '${pause}'`);
  expect(source).toContain(`pause === '${pause}'`);
  expect(source).toContain(
    '仅同步本地缓存正文；保留已有内嵌图片，外部图片未新抓取、未验证',
  );
});
