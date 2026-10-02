import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { canonicalArticleUrl } from './collection-format';
import { readOwnerSearchConfig } from './owner-search-update';
import { fetchOwnerSearchPage } from './owner-web-search';

/** Refresh only the private search index view. A candidate has no trusted body
 * or publication time and must never be sent through article persistence.
 * Original-article access stops do not block this separate search request;
 * the search transport retains its own cooldown and durable access stops.
 */
export async function scanOwnerCandidates(mpId: string) {
  const snapshotFile = process.env.OWNER_SEARCH_CANDIDATE_SNAPSHOT_FILE;
  if (!snapshotFile || !path.isAbsolute(snapshotFile))
    throw new Error('OWNER_CANDIDATE_SNAPSHOT_NOT_CONFIGURED');
  const config = await readOwnerSearchConfig(mpId);
  const result = await fetchOwnerSearchPage({
    sessionFile: config.sessionFile,
    stateFile: config.stateFile,
    ownerVid: config.ownerVid,
    name: config.name,
    biz: config.biz,
    maxPages: config.searchMaxPages ?? 2,
  });
  if (
    result.coverage !== 'search-results' ||
    result.complete !== false ||
    result.candidates.length > 500 ||
    result.candidates.some((candidate) => {
      try {
        const identity = canonicalArticleUrl(candidate.url);
        return (
          candidate.mpId !== mpId ||
          candidate.id !== identity.id ||
          identity.mpId !== mpId ||
          candidate.url !== identity.url ||
          new URL(candidate.url).protocol !== 'https:'
        );
      } catch {
        return true;
      }
    })
  )
    throw new Error('OWNER_CANDIDATE_SNAPSHOT_INVALID');

  // Persist only fields safe for the owner's protected UI. Keep the previous
  // successful snapshot if the network, validation or disk write fails.
  const snapshot = {
    mpId,
    result: {
      candidates: result.candidates.map((candidate) => ({
        id: candidate.id,
        mpId: candidate.mpId,
        url: candidate.url,
        title: candidate.title,
        indexTimestamp: candidate.indexTimestamp,
        discovery: candidate.discovery,
      })),
      pages: result.pages,
      requests: result.requests,
      capturedAt: result.capturedAt,
      truncated: result.truncated,
      termination: result.termination,
      coverage: result.coverage,
      complete: false as const,
    },
  };
  const pending = `${snapshotFile}.${randomUUID()}.pending`;
  try {
    const handle = await fs.open(pending, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(snapshot));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(pending, snapshotFile);
  } catch (error) {
    await fs.unlink(pending).catch(() => {});
    throw error;
  }
  return {
    status: 'candidate_scan_only' as const,
    candidates: snapshot.result.candidates.length,
    pages: result.pages,
    capturedAt: result.capturedAt,
    truncated: result.truncated,
    complete: false as const,
  };
}
