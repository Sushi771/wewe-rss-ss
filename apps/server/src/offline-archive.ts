import { createWriteStream } from 'node:fs';
import { ZipArchive } from 'archiver';

/** Existing offline ZIP packaging, shared by feed export and the article tool. */
export async function archiveDirectory(folder: string, archivePath: string) {
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(archivePath);
    const archive = new ZipArchive({ zlib: { level: 6 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(folder, false);
    archive.finalize().catch(reject);
  });
}
