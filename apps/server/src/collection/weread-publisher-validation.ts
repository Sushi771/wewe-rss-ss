import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { load } from 'cheerio';
import { articleIdentity } from './article-page';
import { ownerConfigFile } from './owner-weread-binding';
import {
  NativeWereadAccount,
  resolveNativeWereadAccount,
} from './owner-weread-account';
import {
  ownerLatestFailureReason,
  ownerLatestStopMessage,
} from './owner-weread-session-state';
import { parseWereadDirectory, selectWereadLatest } from './weread-directory';
import {
  createWereadNativeRequester,
  WereadNativeRequestError,
  WereadNativeRequester,
} from './weread-native-request';
import { collectWereadLatestDirectory } from './weread-latest-collection';
import { SearchConfig } from './owner-search-update';

export type WereadCandidateErrorCode =
  | 'MANUAL_ONLY'
  | 'PUBLIC_IDENTITY_INVALID'
  | 'ACCOUNT_NOT_READY'
  | 'RETAINED_STOP'
  | 'ATTEMPT_CONSUMED'
  | 'IN_PROGRESS'
  | 'STATE_CHANGED'
  | 'STATE_IO_FAILED'
  | 'UPSTREAM_HTTP'
  | 'UPSTREAM_BUSINESS'
  | 'DIRECTORY_INVALID'
  | 'EMPTY_DIRECTORY'
  | 'REQUEST_FAILED'
  | 'INVALID_EVIDENCE'
  | 'BINDING_FAILED'
  | 'BINDING_REQUIRED'
  | 'COLLECTION_FAILED';

/** Safe error contract: never forwards upstream text, paths or credentials. */
export class WereadCandidateValidationError extends Error {
  constructor(
    public readonly code: WereadCandidateErrorCode,
    public readonly httpStatus?: number,
    public readonly businessCode?: number,
  ) {
    super(code);
  }
}
const fail = (code: WereadCandidateErrorCode) =>
  new WereadCandidateValidationError(code);
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const read = async (file: string) =>
  JSON.parse(await fs.readFile(file, 'utf8'));

export function wereadPublisherCandidateFromOriginal(html: string) {
  try {
    if (typeof html !== 'string' || Buffer.byteLength(html) > 10 * 1024 * 1024)
      throw fail('PUBLIC_IDENTITY_INVALID');
    const $ = load(html);
    if (
      $('#js_verify,#verify,.weui_msg,form[action*="/mp/verify"]').length ||
      /wappoc_appmsgcaptcha|verify\.html/i.test(html)
    )
      throw fail('PUBLIC_IDENTITY_INVALID');
    const identity = articleIdentity(html);
    const name = $('#js_name').text().trim();
    if (
      !identity.canonical ||
      !identity.publishTime ||
      !$('#activity-name').text().trim() ||
      !name ||
      name.length > 200 ||
      /[\x00-\x1f\x7f]/.test(name)
    )
      throw fail('PUBLIC_IDENTITY_INVALID');
    return {
      mpId: identity.mpId,
      name,
      biz: new URL(identity.url).searchParams.get('__biz')!,
      publicArticleUrl: identity.canonical,
      publicArticleSha256: sha(html),
      bookIdStatus: 'candidate' as const,
    };
  } catch {
    throw fail('PUBLIC_IDENTITY_INVALID');
  }
}

export type VerifiedWereadPublisherCandidate = {
  status: 'directory-verified';
  candidate: ReturnType<typeof wereadPublisherCandidateFromOriginal>;
  directory: ReturnType<typeof parseWereadDirectory>;
  selection: ReturnType<typeof selectWereadLatest>;
  bindingEvidence: {
    source: 'normal-native-candidate-directory';
    accountId: string;
    mpId: string;
    name: string;
    publicArticleSha256: string;
    directorySha256: string;
    verifiedAt: string;
    revision: string;
    requests: 1;
    bodyVerified: false;
  };
};
type AccountContext = Awaited<ReturnType<typeof resolveNativeWereadAccount>>;
type PrivateContext = {
  configFile: string;
  account: NativeWereadAccount;
  accountContext: AccountContext;
  attemptFile: string;
  state: any;
  stage: string;
  requests: number;
  get: WereadNativeRequester;
  rawPages: unknown[];
  result: VerifiedWereadPublisherCandidate;
  bound: boolean;
  continued: boolean;
};
const contexts = new WeakMap<
  VerifiedWereadPublisherCandidate,
  PrivateContext
>();

async function atomicState(file: string, state: unknown) {
  const pending = file + '.pending';
  const handle = await fs.open(pending, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(state));
    await handle.sync();
  } finally {
    await handle.close();
  }
  // A failed publication leaves the owned pending file as a fail-closed gate.
  await fs.rename(pending, file);
}

/** Config and known state locks prevent concurrent login/binding/refresh changes.
 * Existing active stops for this selected account block new target discovery.
 * Historical explicitly authorized successful maintenance is evaluated by the
 * existing stop function; this module never clears or grants such authorization.
 */
async function underAccountLocks<T>(
  configFile: string,
  account: NativeWereadAccount,
  attemptFile: string,
  run: (context: AccountContext) => Promise<T>,
) {
  const held: Array<{
    file: string;
    handle: Awaited<ReturnType<typeof fs.open>>;
  }> = [];
  const lock = async (file: string) => {
    try {
      held.push({ file, handle: await fs.open(file, 'wx', 0o600) });
    } catch {
      throw fail('IN_PROGRESS');
    }
  };
  try {
    await lock(configFile + '.native-login.lock');
    await lock(attemptFile + '.lock');
    let context: AccountContext;
    try {
      context = await resolveNativeWereadAccount(account, configFile);
    } catch {
      throw fail('ACCOUNT_NOT_READY');
    }
    const config = await read(configFile);
    if (
      !config.feeds ||
      typeof config.feeds !== 'object' ||
      Array.isArray(config.feeds)
    )
      throw fail('STATE_CHANGED');
    const feeds = Object.entries(config.feeds) as Array<[string, any]>;
    const selected = feeds.filter(
      ([mpId, binding]) =>
        binding?.ownerVid === account.id ||
        path.basename(attemptFile) ===
          `candidate-directory-${sha(mpId).slice(0, 24)}.json`,
    );
    if (selected.length > 1000) throw fail('STATE_CHANGED');
    const lockedFiles = new Set<string>([path.resolve(attemptFile)]);
    for (const [mpId, binding] of selected.sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      // Discovery is not an account-transfer authorization. In particular a
      // target stopped under another account cannot be retried through this one.
      if (binding.ownerVid !== account.id) throw fail('RETAINED_STOP');
      const file = binding.wereadLatestStateFile;
      if (typeof file !== 'string' || !path.isAbsolute(file))
        throw fail('STATE_CHANGED');
      const resolved = path.resolve(file);
      if (!lockedFiles.has(resolved)) {
        await lock(file + '.lock');
        lockedFiles.add(resolved);
      }
      let state: any;
      try {
        state = await read(file);
      } catch (error: any) {
        if (error.code === 'ENOENT') continue;
        throw fail('STATE_CHANGED');
      }
      if (
        state.normalManualRenewalStop ||
        ownerLatestStopMessage(state, context.session, account.id, mpId)
      )
        throw fail('RETAINED_STOP');
    }
    // A failed candidate attempt also blocks this same account from trying a
    // different publisher as a way around that failure. No new account fallback.
    for (const name of await fs.readdir(path.dirname(configFile))) {
      if (!/^candidate-directory-[a-f0-9]{24}\.json$/.test(name)) continue;
      const state = await read(path.join(path.dirname(configFile), name));
      if (state.accountId === account.id && state.stop)
        throw fail('RETAINED_STOP');
    }
    return await run(context);
  } catch (error) {
    throw safeError(error, 'STATE_IO_FAILED');
  } finally {
    let cleanupFailed = false;
    for (const item of held.reverse()) {
      try {
        await item.handle.close();
        await fs.unlink(item.file);
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) throw fail('STATE_IO_FAILED');
  }
}

function safeError(error: unknown, fallback: WereadCandidateErrorCode) {
  if (error instanceof WereadCandidateValidationError) return error;
  if (error instanceof WereadNativeRequestError)
    return new WereadCandidateValidationError(
      error.code === 'HTTP_STATUS'
        ? 'UPSTREAM_HTTP'
        : error.code === 'BUSINESS_REFUSED'
          ? 'UPSTREAM_BUSINESS'
          : 'DIRECTORY_INVALID',
      error.status,
      error.businessCode,
    );
  return fail(fallback);
}

/** No-network preflight for the URL resolver. A long URL may supply only a
 * candidate ID here; the public response must still prove its real identity.
 */
export async function assertNativeWereadCandidateAccount(input: {
  account: NativeWereadAccount;
  candidateMpId?: string;
  configFile?: string;
}) {
  const configFile = input.configFile || ownerConfigFile();
  const attemptFile = path.join(
    path.dirname(configFile),
    `candidate-directory-${sha(input.candidateMpId || 'preflight:' + input.account.id).slice(0, 24)}.json`,
  );
  await underAccountLocks(
    configFile,
    input.account,
    attemptFile,
    async () => undefined,
  );
}

async function retainStop(context: PrivateContext, error: unknown) {
  context.state.status = 'stopped';
  context.state.stop = {
    at: new Date().toISOString(),
    stage: context.stage,
    requests: context.requests,
    sessionAuthHash: context.accountContext.authHash,
    reason: ownerLatestFailureReason(error),
  };
  await atomicState(context.attemptFile, context.state);
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Server-only entry. HTML must come from the caller's reviewed server-owned
 * public original, never client-supplied HTML/state. No binding is required.
 * Local-manual action reserves exactly one first-directory request durably.
 * No body requests, feed/config mutations, renewal, signatures or retries here.
 */
export async function validateWereadPublisherCandidate(input: {
  account: NativeWereadAccount;
  publicArticleHtml: string;
  trigger: 'local-manual';
  /** Internal override for isolated tests/integration; never an HTTP parameter. */
  configFile?: string;
}): Promise<VerifiedWereadPublisherCandidate> {
  if (input.trigger !== 'local-manual') throw fail('MANUAL_ONLY');
  const candidate = wereadPublisherCandidateFromOriginal(
    input.publicArticleHtml,
  );
  let configFile: string;
  try {
    configFile = input.configFile || ownerConfigFile();
  } catch {
    throw fail('STATE_CHANGED');
  }
  if (!path.isAbsolute(configFile)) throw fail('STATE_CHANGED');
  const attemptFile = path.join(
    path.dirname(configFile),
    `candidate-directory-${sha(candidate.mpId).slice(0, 24)}.json`,
  );
  return underAccountLocks(
    configFile,
    input.account,
    attemptFile,
    async (accountContext) => {
      try {
        await fs.access(attemptFile);
        throw fail('ATTEMPT_CONSUMED');
      } catch (error: any) {
        if (error.code !== 'ENOENT') throw error;
      }
      const state: any = {
        status: 'reserved',
        accountId: input.account.id,
        candidate,
        lastAttemptAt: Date.now(),
        sessionAuthHash: accountContext.authHash,
        requests: 0,
      };
      // A crash or failed write never grants another attempt from a fresh process.
      const reservation = await fs.open(attemptFile, 'wx', 0o600);
      try {
        await reservation.writeFile(JSON.stringify(state));
        await reservation.sync();
      } finally {
        await reservation.close();
      }
      const context: PrivateContext = {
        configFile,
        account: { ...input.account },
        accountContext,
        attemptFile,
        state,
        stage: 'directory-0',
        requests: 0,
        get: undefined as unknown as WereadNativeRequester,
        rawPages: [],
        result: undefined as unknown as VerifiedWereadPublisherCandidate,
        bound: false,
        continued: false,
      };
      const request = createWereadNativeRequester(
        accountContext.session,
        input.account.id,
        async (response) => {
          await fs.writeFile(
            `${attemptFile}.${context.stage}.response`,
            response.data,
            { flag: 'wx', mode: 0o600 },
          );
          state.response = {
            stage: context.stage,
            httpStatus: response.status,
            bytes: Buffer.byteLength(response.data),
            requests: context.requests,
          };
          state.requests = context.requests;
          await atomicState(attemptFile, state);
        },
        () => {
          context.requests++;
        },
      );
      context.get = request;
      try {
        const text = await context.get(
          'https://weread.qq.com/web/mp/articles',
          {
            bookId: candidate.mpId,
            offset: '0',
          },
        );
        const raw = JSON.parse(text);
        let directory: ReturnType<typeof parseWereadDirectory>;
        let selection: ReturnType<typeof selectWereadLatest>;
        try {
          directory = parseWereadDirectory(raw, candidate);
          selection = selectWereadLatest([raw], candidate);
        } catch {
          throw fail('DIRECTORY_INVALID');
        }
        if (!directory.articles.length) throw fail('EMPTY_DIRECTORY');
        // Explicit distinction: public-derived bookId was only a candidate until
        // this actual nonempty directory verified belongBookId/name/review IDs.
        const bindingEvidence: VerifiedWereadPublisherCandidate['bindingEvidence'] =
          {
            source: 'normal-native-candidate-directory',
            accountId: input.account.id,
            mpId: candidate.mpId,
            name: candidate.name,
            publicArticleSha256: candidate.publicArticleSha256,
            directorySha256: sha(text),
            verifiedAt: new Date().toISOString(),
            revision: sha(
              JSON.stringify([
                candidate,
                accountContext.accountRevision,
                sha(text),
              ]),
            ),
            requests: 1,
            bodyVerified: false,
          };
        state.status = 'directory-verified';
        state.bindingEvidence = bindingEvidence;
        await atomicState(attemptFile, state);
        const result = freeze({
          status: 'directory-verified' as const,
          candidate,
          directory,
          selection,
          bindingEvidence,
        });
        context.result = result;
        context.rawPages = [raw];
        contexts.set(result, context);
        return result;
      } catch (error) {
        await retainStop(context, error);
        throw safeError(error, 'REQUEST_FAILED');
      }
    },
  );
}

async function checkedContext<T>(
  result: VerifiedWereadPublisherCandidate,
  run: (context: PrivateContext) => Promise<T>,
) {
  const context = contexts.get(result);
  if (!context) throw fail('INVALID_EVIDENCE');
  return underAccountLocks(
    context.configFile,
    context.account,
    context.attemptFile,
    async (current) => {
      if (current.accountRevision !== context.accountContext.accountRevision)
        throw fail('STATE_CHANGED');
      const state = await read(context.attemptFile);
      if (
        JSON.stringify(state) !== JSON.stringify(context.state) ||
        state.bindingEvidence?.revision !== result.bindingEvidence.revision
      )
        throw fail('STATE_CHANGED');
      return run(context);
    },
  );
}

/** Private binding contract. The caller owns a consistent backup, SQLite
 * transaction and filesystem publication/rollback. Recheck the DB account in
 * that transaction. On callback failure no binding is reported, no retry occurs,
 * and the verified directory can be used for a LOCAL transaction retry only.
 * No fallible audit write follows a successful callback's commit.
 */
export async function withVerifiedWereadCandidateBinding<T>(
  result: VerifiedWereadPublisherCandidate,
  commit: (context: {
    binding: SearchConfig & {
      wereadDirectoryEnabled: true;
      sourcePolicy: 'native-directory-only';
    };
    evidence: VerifiedWereadPublisherCandidate['bindingEvidence'];
    accountRevision: string;
  }) => Promise<T>,
) {
  return checkedContext(result, async (context) => {
    if (context.bound || context.continued) throw fail('ATTEMPT_CONSUMED');
    let value: T;
    try {
      const config = await read(context.configFile);
      const previous = config.feeds?.[result.candidate.mpId];
      value = await commit({
        binding: {
          mpId: result.candidate.mpId,
          name: result.candidate.name,
          biz: result.candidate.biz,
          ownerVid: context.account.id,
          sessionFile: context.accountContext.sessionFile,
          wereadLatestStateFile: context.attemptFile,
          wereadDirectoryEnabled: true,
          sourcePolicy: 'native-directory-only',
          // Dormant search lifecycle paths are explicit private paths, not
          // fabricated upstream stops. The policy blocks those transports.
          stateFile:
            previous?.stateFile || context.attemptFile + '.search-state.json',
          runtimeStopFile:
            previous?.runtimeStopFile ||
            context.attemptFile + '.search-stop.json',
          originalStopFiles: Array.isArray(previous?.originalStopFiles)
            ? [...previous.originalStopFiles]
            : [],
        },
        evidence: result.bindingEvidence,
        accountRevision: context.accountContext.accountRevision,
      });
    } catch {
      throw fail('BINDING_FAILED');
    }
    context.bound = true;
    return value;
  });
}

/** Continue once after success-only binding, with the same cookie lifecycle and
 * exact first-directory bytes. At most one next directory page and ten bodies;
 * images use the existing byte-validating archiver. Returns the existing
 * ProviderPage for the existing protected saver, not a database write.
 */
export async function continueVerifiedWereadCandidate(
  result: VerifiedWereadPublisherCandidate,
) {
  return checkedContext(result, async (context) => {
    if (!context.bound) throw fail('BINDING_REQUIRED');
    if (context.continued || context.state.continuationReservedAt)
      throw fail('ATTEMPT_CONSUMED');
    context.continued = true;
    context.state.continuationReservedAt = new Date().toISOString();
    await atomicState(context.attemptFile, context.state);
    try {
      const page = await collectWereadLatestDirectory(
        result.candidate,
        context.get,
        (stage) => {
          context.stage = stage;
        },
        { pages: context.rawPages, selection: result.selection },
      );
      context.state.lastSuccessAt = Date.now();
      context.state.articleIds = page.articles.map((article) => article.id);
      context.state.status = 'latest-ten-verified';
      await atomicState(context.attemptFile, context.state);
      return page;
    } catch (error) {
      await retainStop(context, error);
      throw safeError(error, 'COLLECTION_FAILED');
    }
  });
}
