import { access, open, stat } from 'node:fs/promises';

type VerifiedBackup = {
  backup: string;
  sha256: string;
  integrityCheck?: string;
};
type Entry = {
  source: string;
  artifact: string;
  expires: number;
  report: VerifiedBackup;
};
const entries = new Map<string, Entry>();
const lifetime = 30000;

async function identity(file: string) {
  const value = await stat(file, { bigint: true });
  if (!value.isFile() || !value.ino)
    throw new Error('Unprovable file identity');
  return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(
    ':',
  );
}

async function sourceToken(database: string) {
  try {
    // Rollback-journal commits change the header. WAL needs a different proof;
    // an active journal or any unprovable state always forces a fresh backup.
    for (const suffix of ['-wal', '-journal']) {
      try {
        await access(database + suffix);
        return undefined;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          return undefined;
      }
    }
    const before = await identity(database);
    const file = await open(database, 'r');
    let header: Buffer;
    try {
      header = Buffer.alloc(100);
      if ((await file.read(header, 0, 100, 0)).bytesRead !== 100)
        return undefined;
    } finally {
      await file.close();
    }
    if (
      header.subarray(0, 16).toString('binary') !== 'SQLite format 3\0' ||
      header[18] !== 1 ||
      header[19] !== 1 ||
      before !== (await identity(database))
    )
      return undefined;
    return before + ':' + header.toString('hex');
  } catch {
    return undefined;
  }
}

/** Call only under sqliteWrites.snapshot: app writes cannot enter while checking.
 * Reuse is a process-local optimization, never a persisted recovery authority.
 * A commit, file replacement, expired entry, WAL/journal, or missing artifact
 * invalidates it. Failures propagate; an old snapshot never masks fresh failure.
 */
export async function reuseVerifiedSqliteBackup<T extends VerifiedBackup>(
  database: string,
  create: () => Promise<T>,
): Promise<T> {
  const token = await sourceToken(database);
  const entry = entries.get(database);
  if (token && entry?.source === token && entry.expires > Date.now()) {
    try {
      if ((await identity(entry.report.backup)) === entry.artifact)
        return { ...entry.report } as T;
    } catch {
      /* Lost artifact means fresh protection, never stale success. */
    }
  }
  entries.delete(database);
  const report = await create();
  if (token && token === (await sourceToken(database))) {
    try {
      const artifact = await identity(report.backup);
      if (entries.size >= 4) entries.delete(entries.keys().next().value!);
      entries.set(database, {
        source: token,
        artifact,
        report: { ...report },
        expires: Date.now() + lifetime,
      });
    } catch {
      /* Successfully verified backup remains valid without reuse. */
    }
  }
  return report;
}
