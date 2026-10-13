#!/usr/bin/env node
// Explicit single-request candidate check only; never registers a production source.
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const codes = new Set([
  'RNOTE_ARGUMENT_INVALID',
  'RNOTE_BUILD_REQUIRED',
  'RNOTE_CANDIDATE_CONFIG_FAILED',
  'RNOTE_ID_INVALID',
  'RNOTE_PARAMETER_INVALID',
  'RNOTE_CURSOR_INVALID',
  'RNOTE_BASE_URL_INVALID',
  'RNOTE_KEY_INVALID',
  'RNOTE_KEY_MISSING',
  'RNOTE_REDIRECT_REJECTED',
  'RNOTE_AUTH_INVALID',
  'RNOTE_BALANCE_INSUFFICIENT',
  'RNOTE_SCOPE_DENIED',
  'RNOTE_RATE_LIMITED',
  'RNOTE_RESPONSE_INVALID',
  'RNOTE_RESPONSE_TOO_LARGE',
  'RNOTE_HTTP_FAILED',
  'RNOTE_BUSINESS_REJECTED',
  'RNOTE_TIMEOUT',
  'RNOTE_REQUEST_FAILED',
  'RNOTE_PAYLOAD_UNVERIFIED',
  'RNOTE_LIST_SHAPE_UNVERIFIED',
  'RNOTE_DETAIL_SHAPE_UNVERIFIED',
]);
async function main() {
  let values;
  try {
    values = parseArgs({
      args: process.argv.slice(2),
      options: {
        execute: { type: 'boolean', default: false },
        operation: { type: 'string' },
        id: { type: 'string' },
        cursor: { type: 'string' },
      },
    }).values;
  } catch {
    throw new Error('RNOTE_ARGUMENT_INVALID');
  }
  if (!values.execute) {
    console.log(
      JSON.stringify({
        mode: 'no-request',
        contract: 'rnote-public-v2',
        productCompatibilityVerified: false,
        evidenceVerified: false,
        requiredKeys: ['XHS_SELF_HOSTED_BASE_URL', 'XHS_SELF_HOSTED_API_KEY'],
        operations: [
          'posted',
          'image',
          'video',
          'pgy-notes',
          'pgy-notes-v2',
          'pgy-detail',
        ],
      }),
    );
    return;
  }
  if (
    !values.id ||
    ![
      'posted',
      'image',
      'video',
      'pgy-notes',
      'pgy-notes-v2',
      'pgy-detail',
    ].includes(values.operation) ||
    (values.cursor !== undefined && values.operation !== 'posted')
  )
    throw new Error('RNOTE_ARGUMENT_INVALID');
  let Client, Candidate;
  try {
    Client = require(
      path.join(
        root,
        'apps/server/dist/apps/server/src/collection/providers/rnote-public-client.js',
      ),
    ).RnotePublicClient;
    Candidate = require(
      path.join(
        root,
        'apps/server/dist/apps/server/src/collection/providers/rnote-public-candidate.js',
      ),
    ).RnotePublicCandidate;
  } catch {
    throw new Error('RNOTE_BUILD_REQUIRED');
  }
  let config;
  try {
    const file = path.join(root, '.xhs-self-hosted/.env.local');
    if (
      fs.lstatSync(path.dirname(file)).isSymbolicLink() ||
      fs.lstatSync(file).isSymbolicLink()
    )
      throw new Error();
    const serverRequire = createRequire(
      path.join(root, 'apps/server/package.json'),
    );
    config = createRequire(serverRequire.resolve('@nestjs/config'))(
      'dotenv',
    ).parse(fs.readFileSync(file));
  } catch {
    throw new Error('RNOTE_CANDIDATE_CONFIG_FAILED');
  }
  const client = new Client(
    {
      baseUrl: config.XHS_SELF_HOSTED_BASE_URL || '',
      apiKey: config.XHS_SELF_HOSTED_API_KEY,
    },
    fetch,
  );
  const candidate = new Candidate(client);
  const operation = values.operation;
  const result =
    operation === 'posted'
      ? await candidate.creator(values.id, values.cursor || '', 3)
      : operation === 'pgy-detail'
        ? await candidate.pgyNote(values.id)
        : operation.startsWith('pgy-notes')
          ? await candidate.pgyCreator(
              values.id,
              1,
              3,
              operation === 'pgy-notes' ? 'notes' : 'notes_v2',
            )
          : await candidate.note(values.id, operation);
  // Business response stays in memory. No body/ID/URL/key/debug_info dump or DB write.
  console.log(
    JSON.stringify({
      mode: 'single-candidate-read',
      operation,
      contract: result.contract,
      requests: 1,
      productCompatibilityVerified: false,
      evidenceVerified: false,
      billed: result.billed,
      candidateCount: result.noteIds?.length,
      hasMore: result.hasMore,
      dataFieldNames: Object.keys(result.data).filter((name) =>
        /^[a-zA-Z_][a-zA-Z_0-9]{0,63}$/.test(name),
      ),
      canRefresh: false,
    }),
  );
}
main().catch((error) => {
  console.error(
    codes.has(error.message) ? error.message : 'RNOTE_CANDIDATE_READ_FAILED',
  );
  process.exitCode = 1;
});
