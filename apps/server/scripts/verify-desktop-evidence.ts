import { readFile } from 'node:fs/promises';
import { verifyDesktopEvidence } from '../src/collection/desktop-wechat';

async function main() {
  const [mpId, mpName, evidencePath] = process.argv.slice(2);
  if (!mpId || !mpName || !evidencePath) {
    throw new Error(
      'Usage: ts-node verify-desktop-evidence.ts MP_ID MP_NAME EVIDENCE_JSON',
    );
  }
  const evidence = await readFile(evidencePath, 'utf8');
  const articles = await verifyDesktopEvidence(mpId, mpName, evidence);
  process.stdout.write(
    JSON.stringify({
      mpId,
      count: articles.length,
      bodyFetch: {
        succeeded: articles.filter(
          (item) => item.lastBodyStatus === 'available',
        ).length,
        unavailable: articles.filter(
          (item) => item.lastBodyStatus === 'unavailable',
        ).length,
      },
      latest: articles.map(
        ({ rank, id, title, publishTime, shortUrl, lastBodyStatus }) => ({
          rank,
          id,
          title,
          publishTime,
          shortUrl,
          lastBodyStatus,
        }),
      ),
    }) + '\n',
  );
}

main().catch((error) => {
  process.stderr.write(String(error?.message || error) + '\n');
  process.exitCode = 1;
});
