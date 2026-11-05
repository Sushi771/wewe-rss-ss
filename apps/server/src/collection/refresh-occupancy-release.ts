import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export const releaseDigest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function refreshFeedSourceDigest(feed: {
  id: string;
  collectionChannel: string | null;
  mpName: string;
  status: number;
  createdAt: Date;
}) {
  return releaseDigest([
    1,
    feed.id,
    feed.collectionChannel,
    feed.mpName,
    feed.status,
    feed.createdAt.getTime(),
  ]);
}
export type UnknownReleaseBinding = {
  instance: string;
  batchId: string;
  intentKey: string;
  feedId: string;
  index: number;
  itemSha256: string;
  sourceSha256: string;
};
export type UnknownOccupancyRelease = UnknownReleaseBinding & {
  version: 1;
  action: 'release-future-rounds-only';
  approvedAt: number;
  resolvedAt: number;
  futureRoundNotBefore: number;
  approvalSha256: string;
  evidenceSha256: string;
  approvalFile: string;
  evidenceFile: string;
};
const hex = (s: unknown) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
export function validUnknownRelease(
  value: unknown,
): value is UnknownOccupancyRelease {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as UnknownOccupancyRelease;
  return (
    Object.keys(v).sort().join(',') ===
      'action,approvalFile,approvalSha256,approvedAt,batchId,evidenceFile,evidenceSha256,feedId,futureRoundNotBefore,index,instance,intentKey,itemSha256,resolvedAt,sourceSha256,version' &&
    v.version === 1 &&
    v.action === 'release-future-rounds-only' &&
    [
      v.instance,
      v.intentKey,
      v.itemSha256,
      v.sourceSha256,
      v.approvalSha256,
      v.evidenceSha256,
    ].every(hex) &&
    /^[a-f0-9-]{36}$/.test(v.batchId) &&
    /^MP_WXS_\d{5,15}$/.test(v.feedId) &&
    Number.isSafeInteger(v.index) &&
    v.index >= 0 &&
    v.index < 1000 &&
    [v.approvedAt, v.resolvedAt, v.futureRoundNotBefore].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    ) &&
    v.approvedAt <= v.resolvedAt &&
    v.futureRoundNotBefore >= v.resolvedAt &&
    [v.approvalFile, v.evidenceFile].every(
      (s) =>
        typeof s === 'string' &&
        s.length <= 4096 &&
        !/[\0\r\n]/.test(s) &&
        path.isAbsolute(s),
    )
  );
}
/** Excludes only this additive disposition; polling fields are frozen after release. */
export function unknownItemDigest(item: object) {
  const copy = { ...item } as Record<string, unknown>;
  delete copy.occupancyRelease;
  return releaseDigest(copy);
}
async function evidenceFile(file: string, limit: number) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    const link = await fs.lstat(file);
    if (
      !stat.isFile() ||
      link.isSymbolicLink() ||
      stat.size < 1 ||
      stat.size > limit ||
      stat.ino !== link.ino ||
      stat.dev !== link.dev
    )
      throw Error('UNKNOWN_RELEASE_EVIDENCE_INVALID');
    const bytes = Buffer.alloc(limit + 1);
    const read = await handle.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead !== stat.size || read.bytesRead > limit)
      throw Error('UNKNOWN_RELEASE_EVIDENCE_INVALID');
    const data = bytes.subarray(0, read.bytesRead);
    return { data, sha256: createHash('sha256').update(data).digest('hex') };
  } finally {
    await handle.close();
  }
}
export async function readUnknownReleaseApproval(
  input: {
    approvalFile: string;
    approvalSha256: string;
    evidenceFile: string;
  },
  binding: UnknownReleaseBinding,
  now: number,
): Promise<UnknownOccupancyRelease> {
  try {
    if (!hex(input.approvalSha256)) throw Error();
    const approval = await evidenceFile(input.approvalFile, 8192);
    if (approval.sha256 !== input.approvalSha256) throw Error();
    const raw = JSON.parse(
      approval.data.toString('utf8').replace(/^\uFEFF/, ''),
    );
    if (
      Object.keys(raw).sort().join(',') !==
        'action,approvedAt,authorized,batchId,evidenceSha256,feedId,futureRoundNotBefore,index,instance,intentKey,itemSha256,sourceSha256,version' ||
      raw.authorized !== true
    )
      throw Error();
    for (const [key, value] of Object.entries(binding))
      if (raw[key] !== value) throw Error();
    const evidence = await evidenceFile(input.evidenceFile, 1024 * 1024);
    if (
      !hex(raw.evidenceSha256) ||
      raw.evidenceSha256 !== evidence.sha256 ||
      !evidence.data.toString('utf8').trim()
    )
      throw Error();
    const record = { ...raw };
    delete record.authorized;
    const release = {
      ...record,
      resolvedAt: now,
      approvalSha256: approval.sha256,
      approvalFile: await fs.realpath(input.approvalFile),
      evidenceFile: await fs.realpath(input.evidenceFile),
    };
    if (!validUnknownRelease(release) || now - release.approvedAt > 3600000)
      throw Error();
    return release;
  } catch {
    throw Error('UNKNOWN_RELEASE_EVIDENCE_INVALID');
  }
}
/** Private proof locations never enter the product projection. */
export function unknownReleaseSummary(release?: UnknownOccupancyRelease) {
  if (!release) return;
  const copy = { ...release } as Partial<UnknownOccupancyRelease>;
  delete copy.approvalFile;
  delete copy.evidenceFile;
  return copy;
}
