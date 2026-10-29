import * as path from 'node:path';
import {readFileSync} from 'node:fs';
/** Packaged runtime installs its manifest-verified module before any DB access. */
export function projectWriterGate(): any {
  const api=(globalThis as any)[Symbol.for('wewe.project-writer-api.v1')];
  if(api)return api;
  // Direct Nest development starts use the checked-out module, never an arbitrary fallback path.
  const server=process.cwd();
  if(JSON.parse(readFileSync(path.join(server,'package.json'),'utf8')).name!=='server')throw Error('PROJECT_WRITER_RUNTIME_REQUIRED');
  return require(path.resolve(server,'../../scripts/local-release/project-writer-gate.cjs'));
}
