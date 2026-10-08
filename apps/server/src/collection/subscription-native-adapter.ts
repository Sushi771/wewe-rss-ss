import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { CollectionService } from './collection.service';
import { canonicalArticleUrl } from './collection-format';
import { articleIdentity } from './article-page';
import { ownerConfigFile } from './owner-weread-binding';
import { resolveNativeWereadAccount } from './owner-weread-account';
import { downloadArticleUrl } from '../article-download';
import { WereadPublicOriginalResult } from './weread-public-original';
import { NativeWereadAccount } from './owner-weread-account';
import {
  validateWereadPublisherCandidate,
  withVerifiedWereadCandidateBinding,
  wereadPublisherCandidateFromOriginal,
  WereadCandidateValidationError,
} from './weread-publisher-validation';
import {
  DiscoveryOutcome,
  DiscoveryStage,
  SubscriptionDiscoveryValidator,
  SubscriptionRegistrationError,
  StagedSubscription,
} from './subscription-add';

/** A server resolver supplies reviewed original provenance. No client HTML/hash,
 * cookies, credential export or generic page upload. It must honor its own access
 * stops and use bounded original-page transport or already reviewed evidence.
 */
export type PublicOriginalResolver = (
  articleUrl: string,
  account: NativeWereadAccount,
) => Promise<
  | {
      requestedUrl: string;
      html: string;
    }
  | WereadPublicOriginalResult
>;
const normalize = (value: string) =>
  value.normalize('NFKC').replace(/\s+/gu, '');
async function immutable(file: string, text: string) {
  try {
    await fs.writeFile(file, text, { flag: 'wx', mode: 0o600 });
  } catch (e: any) {
    if (e.code !== 'EEXIST' || (await fs.readFile(file, 'utf8')) !== text)
      throw e;
  }
}
async function replace(file: string, text: string, revision: string) {
  const pending = file + `.subscription-${revision}.pending`;
  await fs.writeFile(pending, text, { flag: 'wx', mode: 0o600 });
  try {
    await fs.rename(pending, file);
  } catch (error) {
    await fs.unlink(pending);
    throw error;
  }
}
function failure(error: unknown, stage: DiscoveryStage): DiscoveryOutcome {
  const code =
    error instanceof WereadCandidateValidationError ? error.code : undefined;
  const mapped =
    error instanceof SubscriptionRegistrationError
      ? error.code
      : code === 'PUBLIC_IDENTITY_INVALID'
        ? 'IDENTITY_UNRESOLVED'
        : code === 'ACCOUNT_NOT_READY'
          ? 'ACCOUNT_LOGIN_REQUIRED'
          : ['RETAINED_STOP', 'ATTEMPT_CONSUMED'].includes(code || '')
            ? 'ATTEMPT_STOPPED'
            : code === 'IN_PROGRESS'
              ? 'ATTEMPT_BUSY'
              : code === 'EMPTY_DIRECTORY'
                ? 'DIRECTORY_EMPTY'
                : code === 'DIRECTORY_INVALID'
                  ? 'IDENTITY_CONFLICT'
                  : ['UPSTREAM_HTTP', 'UPSTREAM_BUSINESS'].includes(code || '')
                    ? stage === 'directory'
                      ? 'DIRECTORY_REFUSED'
                      : 'BODY_FAILED'
                    : stage === 'session'
                      ? 'ACCOUNT_LOGIN_REQUIRED'
                      : stage === 'identity'
                        ? 'IDENTITY_UNRESOLVED'
                        : stage === 'binding'
                          ? 'BINDING_FAILED'
                          : stage === 'save'
                            ? 'SAVE_FAILED'
                            : 'BODY_FAILED';
  return {
    status: [
      'IDENTITY_UNRESOLVED',
      'ACCOUNT_LOGIN_REQUIRED',
      'DIRECTORY_EMPTY',
    ].includes(mapped)
      ? 'needs-verification'
      : 'blocked',
    stage,
    code: mapped,
    ...(error instanceof WereadCandidateValidationError
      ? {
          httpStatus: error.httpStatus,
          businessCode: error.businessCode,
        }
      : {}),
  };
}

/** Concrete consumer of owner's non-prebound native validator. No default
 * registration/resolver is supplied: operator wiring is explicit, not a network
 * side effect of importing this module or viewing the capability query.
 */
export function createNativeSubscriptionDiscovery(options: {
  prisma: PrismaClient;
  collection: CollectionService;
  resolveOriginal: PublicOriginalResolver;
  configFile?: string;
}): SubscriptionDiscoveryValidator {
  return {
    discover: async (input, stageFeed) => {
      let stage: DiscoveryStage = 'session';
      try {
        const configFile = options.configFile || ownerConfigFile();
        if (!path.isAbsolute(configFile))
          return { status: 'failed', stage, code: 'SOURCE_UNAVAILABLE' };
        const account = await options.prisma.account.findUniqueOrThrow({
          where: { id: input.accountId },
        });
        const accountContext = await resolveNativeWereadAccount(
          account,
          configFile,
        );
        stage = 'identity';
        const original = await options.resolveOriginal(
          input.articleUrl,
          account,
        );
        if ('status' in original && original.status !== 'reviewed-original')
          return {
            status:
              original.status === 'verification-required'
                ? 'needs-verification'
                : 'blocked',
            stage,
            code:
              original.status === 'verification-required'
                ? 'PUBLIC_ORIGINAL_VERIFICATION_REQUIRED'
                : original.redirectKind === 'login'
                  ? 'PUBLIC_ORIGINAL_LOGIN_REDIRECT'
                  : original.redirectKind === 'article'
                    ? 'PUBLIC_ORIGINAL_ARTICLE_REDIRECT'
                    : ['other', 'missing'].includes(original.redirectKind || '')
                      ? 'PUBLIC_ORIGINAL_UNSUPPORTED_REDIRECT'
                      : 'PUBLIC_ORIGINAL_REFUSED',
            httpStatus: original.upstreamStatus,
            ...(original.officialVerification
              ? {
                  officialVerification: original.officialVerification,
                }
              : {}),
          };
        if (
          downloadArticleUrl(original.requestedUrl) !==
          downloadArticleUrl(input.articleUrl)
        )
          throw new Error('ORIGINAL_REQUEST_MISMATCH');
        const candidate = wereadPublisherCandidateFromOriginal(original.html);
        if (
          new URL(input.articleUrl).pathname === '/s' &&
          canonicalArticleUrl(input.articleUrl).id !==
            articleIdentity(original.html).id
        )
          throw new SubscriptionRegistrationError('FEED_IDENTITY_CONFLICT');
        const old = await options.prisma.feed.findUnique({
          where: { id: candidate.mpId },
        });
        if (old && normalize(old.mpName) !== normalize(candidate.name))
          throw new SubscriptionRegistrationError('FEED_IDENTITY_CONFLICT');
        const assertAccount = async (tx: Prisma.TransactionClient) => {
          const fresh = await tx.account.findUniqueOrThrow({
            where: { id: input.accountId },
          });
          const checked = await resolveNativeWereadAccount(fresh, configFile);
          if (checked.accountRevision !== accountContext.accountRevision)
            throw new SubscriptionRegistrationError('FEED_CHANGED');
        };
        const config = JSON.parse(await fs.readFile(configFile, 'utf8'));
        const existing = config.feeds?.[candidate.mpId];
        if (
          old?.collectionChannel === 'owner-weread-latest' &&
          existing?.ownerVid === account.id &&
          existing.biz === candidate.biz &&
          existing.wereadDirectoryEnabled === true &&
          existing.bindingEvidence?.source ===
            'normal-native-candidate-directory' &&
          /^[a-f0-9]{64}$/.test(existing.bindingEvidence?.revision || '')
        ) {
          const receipt = await stageFeed({
            mpId: candidate.mpId,
            name: candidate.name,
            evidenceRevision: existing.bindingEvidence.revision,
            assertAccount,
          });
          await receipt.activate();
          return {
            status: 'already-subscribed',
            stage: 'binding',
            code: 'ALREADY_SUBSCRIBED',
          };
        }
        stage = 'directory';
        const verified = await validateWereadPublisherCandidate({
          account,
          publicArticleHtml: original.html,
          trigger: 'local-manual',
          configFile,
        });
        stage = 'binding';
        await withVerifiedWereadCandidateBinding(verified, async (context) => {
          if (context.accountRevision !== accountContext.accountRevision)
            throw new SubscriptionRegistrationError('FEED_CHANGED');
          const before = await fs.readFile(configFile, 'utf8');
          const current = JSON.parse(before);
          if (
            !current.feeds ||
            Array.isArray(current.feeds) ||
            typeof current.feeds !== 'object'
          )
            throw new Error('BINDING_SCHEMA_INVALID');
          const previous = current.feeds[candidate.mpId];
          if (
            previous &&
            (previous.mpId !== candidate.mpId ||
              previous.biz !== candidate.biz ||
              normalize(previous.name) !== normalize(candidate.name))
          )
            throw new SubscriptionRegistrationError('FEED_IDENTITY_CONFLICT');
          const revision = context.evidence.revision;
          await immutable(
            configFile + `.before-subscription-${revision}`,
            before,
          );
          let receipt: StagedSubscription | undefined;
          const next = {
            ...current,
            feeds: {
              ...current.feeds,
              [candidate.mpId]: {
                ...previous,
                ...context.binding,
                bindingEvidence: context.evidence,
              },
            },
          };
          const after = JSON.stringify(next);
          let published = false;
          try {
            receipt = await stageFeed({
              mpId: candidate.mpId,
              name: candidate.name,
              evidenceRevision: revision,
              assertAccount,
              assertRollback: async () => {
                if (published)
                  throw new SubscriptionRegistrationError('FEED_CHANGED');
              },
            });
            await replace(configFile, after, revision);
            published = true;
            await receipt.activate();
          } catch (error) {
            if (published) {
              // Locks are still held; compensation cannot overwrite a newer config.
              if ((await fs.readFile(configFile, 'utf8')) !== after)
                throw error;
              await replace(configFile, before, revision + '-rollback');
              published = false;
            }
            await receipt?.rollback();
            throw error;
          }
        });
        stage = 'bodies';
        const saved =
          await options.collection.collectVerifiedWereadCandidate(verified);
        stage = 'save';
        return {
          status: 'updated',
          stage,
          code: 'UPDATED',
          update: {
            articles: saved.articles,
            created: saved.created,
            updated: saved.updated,
            bodyMissing: 0,
            imageBlocked: 0,
            saved: true,
          },
        };
      } catch (error) {
        return failure(error, stage);
      }
    },
  };
}
