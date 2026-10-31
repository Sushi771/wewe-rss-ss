import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { xhsOriginalLink } from './xhs-original-link';
import {
  ArticlePreparation,
  SavedSupplement,
  validateLocalDirectory,
} from '../article-local-save';

/** Publish an immutable, content-addressed companion. Never update body, receipt,
 * images or a previous companion, even if a user has edited that companion. */
export function withXhsLocalSnapshot(
  prepare: ArticlePreparation,
  noteId: string,
  title: string,
  snapshot: string | string[],
): ArticlePreparation {
  const publisher = xhsLocalSnapshotPublisher(noteId, title, snapshot);
  if (publisher) prepare.afterSave = publisher;
  return prepare;
}

/** Also used by a fresh ZIP staging directory; publication rules stay identical. */
export function xhsLocalSnapshotPublisher(
  noteId: string,
  title: string,
  snapshot: string | string[],
): ArticlePreparation['afterSave'] {
  if (Array.isArray(snapshot)) {
    const publishers = snapshot.map((part, index) =>
      xhsLocalSnapshotPublisher(
        noteId,
        `${title} (${index + 1}/${snapshot.length})`,
        part,
      ),
    );
    return async (saved) => {
      const receipts: SavedSupplement[] = [];
      for (const publish of publishers) {
        const next = await publish?.(saved);
        if (next) receipts.push(next);
      }
      if (receipts.length !== snapshot.length)
        throw Error('XHS_COMMENT_EXPORT_EMPTY');
      const manifest =
        '# 评论附页索引\n\n' +
        receipts
          .map(
            (receipt, index) =>
              `- [分段 ${index + 1}/${receipts.length}](${encodeURIComponent(path.basename(receipt.path))}) SHA256 ${receipt.sha256}`,
          )
          .join('\n') +
        '\n\n仅含本次已保存范围，未返回与受限内容仍未知。\n';
      return xhsLocalSnapshotPublisher(noteId, title + ' 评论索引', manifest)!(
        saved,
      );
    };
  }
  const snapshotBytes = Buffer.from(
    `# 互动与评论快照 · ${title.replace(/[\r\n]/g, ' ').replace(/[<>]/g, '')}\n\n[原文](${xhsOriginalLink(noteId)})\n\n此附页由平台生成。正文及用户手写内容保持原样；再次保存若数据有变化，会新增快照文件，旧快照保留。\n${snapshot}`,
  );
  const hash = createHash('sha256').update(snapshotBytes).digest('hex');
  const identity = createHash('sha256')
    .update(noteId)
    .digest('hex')
    .slice(0, 16);
  const filename = `互动与评论-${identity}-${hash.slice(0, 24)}.md`;
  if (!snapshot.trim()) return undefined;
  return async (saved) => {
    await validateLocalDirectory(saved.directory);
    const primary = path.join(saved.directory, filename);
    let conflict = false;
    try {
      const stat = await fs.lstat(primary);
      if (
        stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.size === snapshotBytes.length &&
        (await fs.readFile(primary)).equals(snapshotBytes)
      )
        return { path: primary, sha256: hash, status: 'retained' };
      conflict = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (conflict) {
      const prefix = filename.replace(/\.md$/, '-新版本-');
      const candidates = (await fs.readdir(saved.directory))
        .filter((name) => name.startsWith(prefix) && name.endsWith('.md'))
        .sort()
        .slice(-100);
      for (const candidate of candidates) {
        const file = path.join(saved.directory, candidate),
          stat = await fs.lstat(file);
        if (
          stat.isFile() &&
          !stat.isSymbolicLink() &&
          stat.size === snapshotBytes.length &&
          (await fs.readFile(file)).equals(snapshotBytes)
        )
          return { path: file, sha256: hash, status: 'retained' };
      }
    }
    const target = conflict
      ? primary.replace(/\.md$/, `-新版本-${randomUUID()}.md`)
      : primary;
    const temporary = path.join(
      saved.directory,
      `.wewe-xhs-snapshot-${randomUUID()}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(temporary, 'wx');
      await handle.writeFile(snapshotBytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await validateLocalDirectory(saved.directory);
      // Hard-link publication is atomic and refuses an existing destination.
      // A failed publication reports failure; never fall back to an overwrite.
      try {
        await fs.link(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const stat = await fs.lstat(target);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.size !== snapshotBytes.length ||
          !(await fs.readFile(target)).equals(snapshotBytes)
        )
          throw Error('XHS_SNAPSHOT_PUBLICATION_CONFLICT');
        return { path: target, sha256: hash, status: 'retained' as const };
      }
      return {
        path: target,
        sha256: hash,
        status: conflict ? 'conflict-version' : 'new',
      } satisfies SavedSupplement;
    } finally {
      await handle?.close();
      await fs.unlink(temporary).catch(() => {});
    }
  };
}
