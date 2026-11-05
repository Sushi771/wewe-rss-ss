import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { validateLocalDirectory } from './article-local-save';

jest.mock('node:fs/promises', () => ({
  __esModule: true,
  ...jest.requireActual('node:fs/promises'),
}));

describe('bounded fresh ancestor metadata checks', () => {
  afterEach(() => jest.restoreAllMocks());
  it.each([false, true])(
    'checks every component and drains before completion (unsafe=%s)',
    async (unsafe) => {
      const target = path.resolve(
        path.parse(process.cwd()).root,
        'synthetic',
        ...Array.from({ length: 19 }, (_, i) => `part-${i}`),
      );
      let pending = 0,
        peak = 0,
        finished = 0;
      const visited: string[] = [];
      jest.spyOn(fs, 'lstat').mockImplementation((async (file: string) => {
        visited.push(file);
        pending++;
        peak = Math.max(peak, pending);
        await new Promise<void>((resolve) => setImmediate(resolve));
        pending--;
        finished++;
        return {
          isDirectory: () => true,
          isSymbolicLink: () => unsafe && file.endsWith('part-3'),
        };
      }) as any);
      const run = validateLocalDirectory(target);
      if (unsafe)
        await expect(run).rejects.toMatchObject({
          diagnostic: { code: 'UNSAFE_SAVE_DIRECTORY' },
        });
      else await expect(run).resolves.toBe(target);
      expect(peak).toBeGreaterThan(1);
      expect(peak).toBeLessThanOrEqual(8);
      expect(pending).toBe(0);
      expect(finished).toBe(visited.length);
      expect(new Set(visited).size).toBe(visited.length);
      if (!unsafe) expect(visited).toContain(target);
      // No successful validation survives the next call.
      const previous = visited.length;
      await validateLocalDirectory(
        path.resolve(path.parse(target).root, 'other'),
      );
      expect(visited.length).toBeGreaterThan(previous);
    },
  );
});
