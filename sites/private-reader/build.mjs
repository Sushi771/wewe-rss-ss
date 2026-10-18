import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const directory = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(directory, '../..');
const requireWeb = createRequire(
  path.join(repository, 'apps/web/package.json'),
);
const requireVite = createRequire(requireWeb.resolve('vite'));
const esbuild = requireVite('esbuild');

/** Local preparation only. No Site id/manifest, credential or deployment step. */
export async function buildReader(output = path.join(directory, 'dist')) {
  const browser = await esbuild.build({
    entryPoints: [path.join(directory, 'browser.mjs')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    minify: true,
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  const worker = await esbuild.build({
    entryPoints: [path.join(directory, 'worker.mjs')],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    minify: true,
    write: false,
    metafile: true,
    define: {
      __READER_BROWSER_JS__: JSON.stringify(browser.outputFiles[0].text),
    },
    logLevel: 'silent',
  });
  if (browser.warnings.length || worker.warnings.length)
    throw new Error('Reader build has warnings');
  const inputs = [
    ...new Set([
      ...Object.keys(browser.metafile.inputs),
      ...Object.keys(worker.metafile.inputs),
    ]),
  ];
  for (const input of inputs) {
    const resolved = path.resolve(input);
    if (
      resolved !== path.join(repository, 'scripts/sites-local-contract.mjs') &&
      (!resolved.startsWith(directory + path.sep) ||
        resolved.includes(path.sep + 'test' + path.sep))
    )
      throw new Error('Unexpected reader build input');
  }
  await fs.mkdir(path.join(output, 'server'), { recursive: true });
  const file = path.join(output, 'server/index.js');
  await fs.writeFile(file, worker.outputFiles[0].contents);
  return { file, bytes: worker.outputFiles[0].contents.length, inputs };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  console.log(JSON.stringify(await buildReader()));
