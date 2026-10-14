import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

const cursor = z.string().min(1).max(4096).nullable();
const identity = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[^\s\x00-\x1f\x7f]+$/);
const schema = z
  .object({
    version: z.literal(1),
    authorId: identity,
    phase: z.enum([
      'ready',
      'requesting',
      'awaiting-commit',
      'paused',
      'window-complete',
    ]),
    pages: z.number().int().min(0).max(3),
    nextCursor: cursor,
    cursors: z.array(cursor).max(3),
    noteIds: z.array(identity).max(90),
    reason: z
      .enum([
        'none',
        'operator',
        'interrupted',
        'upstream',
        'contract',
        'commit',
      ])
      .default('none'),
  })
  .strict();
export type RedbookScanState = z.infer<typeof schema>;
export function freshRedbookState(authorId: string): RedbookScanState {
  return schema.parse({
    version: 1,
    authorId,
    phase: 'ready',
    pages: 0,
    nextCursor: null,
    cursors: [],
    noteIds: [],
    reason: 'none',
  });
}
export interface RedbookStateStore {
  exclusive<T>(
    authorId: string,
    run: (
      state: RedbookScanState | null,
      save: (state: RedbookScanState) => Promise<void>,
    ) => Promise<T>,
  ): Promise<T>;
}
/** Explicitly supplied private directory. No credential, token, response or URL is persisted.
 * A leftover exclusive lock fails closed; an operator must inspect it after a crash.
 */
export class FileRedbookStateStore implements RedbookStateStore {
  constructor(private readonly directory: string) {
    if (!path.isAbsolute(directory))
      throw new Error('REDBOOK_STATE_DIRECTORY_INVALID');
  }
  async exclusive<T>(
    authorId: string,
    run: (
      state: RedbookScanState | null,
      save: (state: RedbookScanState) => Promise<void>,
    ) => Promise<T>,
  ): Promise<T> {
    identity.parse(authorId);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if ((await fs.lstat(this.directory)).isSymbolicLink())
      throw new Error('REDBOOK_STATE_UNSAFE');
    const file = path.join(
      this.directory,
      createHash('sha256').update(authorId).digest('hex') + '.json',
    );
    const lock = await fs.open(file + '.lock', 'wx', 0o600);
    try {
      let state: RedbookScanState | null = null;
      try {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 100_000)
          throw new Error('REDBOOK_STATE_INVALID');
        state = schema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
        if (state.authorId !== authorId)
          throw new Error('REDBOOK_STATE_IDENTITY_CONFLICT');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      return await run(state, async (next) => {
        schema.parse(next);
        if (next.authorId !== authorId)
          throw new Error('REDBOOK_STATE_IDENTITY_CONFLICT');
        const temporary = file + '.' + randomUUID() + '.tmp';
        try {
          const handle = await fs.open(temporary, 'wx', 0o600);
          try {
            await handle.writeFile(JSON.stringify(next));
            await handle.sync();
          } finally {
            await handle.close();
          }
          await fs.rename(temporary, file);
        } finally {
          await fs.unlink(temporary).catch(() => undefined);
        }
      });
    } finally {
      await lock.close();
      await fs.unlink(file + '.lock');
    }
  }
}
