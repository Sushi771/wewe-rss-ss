import { DynamicModule, Global, Module } from '@nestjs/common';
import { isAbsolute } from 'node:path';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import {
  BrowserTaskBroker,
  BrowserTaskConfiguration,
  BrowserTaskError,
} from './browser-task';
import { BrowserTaskController } from './browser-task.controller';
import { browserTaskBodyParser } from './browser-task.parser';
import { downloadArticleUrl } from './article-download';
import { canonicalArticleUrl } from './collection/collection-format';

const fail = (): never => {
  throw new Error('BROWSER_TASK_OPT_IN_INVALID');
};
const exact = (raw: any, keys: string[]) =>
  raw &&
  !Array.isArray(raw) &&
  typeof raw === 'object' &&
  Object.keys(raw).length === keys.length &&
  keys.every((k) => Object.prototype.hasOwnProperty.call(raw, k));

/** No file is created or loaded without BOTH explicit opt-in settings. A
 * previously consumed/expired approval leaves the normal application disabled.
 * The private file is operator-created only after real user authorization. */
export function readBrowserTaskOptIn(
  env = process.env,
  now = Date.now(),
): BrowserTaskConfiguration | undefined {
  if (env.WEWE_BROWSER_TASK_OPT_IN !== '1') return undefined;
  if (env.PRIVATE_ONLINE_MODE === '1') fail();
  const file = env.WEWE_BROWSER_TASK_OPT_IN_FILE || '';
  if (!file || !isAbsolute(file)) fail();
  let raw: any;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) fail();
    const bytes = readFileSync(file);
    if (bytes.length > 16384) fail();
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail();
  }
  if (
    !exact(raw, [
      'version',
      'approved',
      'approvedAt',
      'expiresAt',
      'localOrigin',
      'extensionOrigin',
      'pairingKey',
      'article',
    ]) ||
    raw.version !== 1 ||
    raw.approved !== true ||
    raw.localOrigin !== 'http://127.0.0.1:4000' ||
    !/^chrome-extension:\/\/[a-p]{32}$/.test(raw.extensionOrigin) ||
    !/^[A-Za-z0-9_-]{43}$/.test(raw.pairingKey)
  )
    fail();
  const approved = Date.parse(raw.approvedAt),
    expires = Date.parse(raw.expiresAt);
  if (
    typeof raw.approvedAt !== 'string' ||
    typeof raw.expiresAt !== 'string' ||
    !Number.isSafeInteger(approved) ||
    !Number.isSafeInteger(expires) ||
    approved > now + 5000 ||
    expires <= approved ||
    expires > approved + 15 * 60 * 1000
  )
    fail();
  const article = raw.article;
  if (
    !exact(article, [
      'originalUrl',
      'title',
      'publisher',
      'publishTime',
      'imageCount',
      'confirmedComplete',
    ]) ||
    article.confirmedComplete !== true ||
    typeof article.title !== 'string' ||
    !article.title.trim() ||
    article.title.length > 1000 ||
    typeof article.publisher !== 'string' ||
    !article.publisher.trim() ||
    article.publisher.length > 1000 ||
    !Number.isSafeInteger(article.publishTime) ||
    article.publishTime < 1 ||
    !Number.isSafeInteger(article.imageCount) ||
    article.imageCount < 0 ||
    article.imageCount > 60
  )
    fail();
  try {
    const url = downloadArticleUrl(article.originalUrl);
    if (new URL(url).pathname !== '/s') fail();
    canonicalArticleUrl(url);
  } catch {
    fail();
  }
  const used = file + '.consumed';
  if (now >= expires || existsSync(used)) return undefined;
  return {
    enabled: true,
    routeVerified: true,
    localOrigin: raw.localOrigin,
    extensionOrigin: raw.extensionOrigin,
    pairingKey: raw.pairingKey,
    confirmedDomArticle: { ...article },
    expiresAt: expires,
    consumeScope() {
      try {
        writeFileSync(
          used,
          JSON.stringify({ version: 1, issuedAt: new Date().toISOString() }),
          { flag: 'wx', mode: 0o600 },
        );
      } catch {
        throw new BrowserTaskError('MANUAL_SCOPE_CONSUMED', 409);
      }
    },
  };
}

@Global()
@Module({})
class BrowserTaskSessionModule {
  static forSession(config: BrowserTaskConfiguration): DynamicModule {
    return {
      module: BrowserTaskSessionModule,
      controllers: [BrowserTaskController],
      providers: [
        { provide: BrowserTaskBroker, useValue: new BrowserTaskBroker(config) },
      ],
      exports: [BrowserTaskBroker],
    };
  }
}
@Module({})
class BrowserTaskOptInAppModule {}

/** Default returns the exact original AppModule: no receiving controller or
 * configured broker is registered. Global export supplies the SAME broker to
 * the original optional download-controller injection when explicitly opted in. */
export function browserTaskApplication(
  config?: BrowserTaskConfiguration,
): typeof AppModule | DynamicModule {
  return config
    ? {
        module: BrowserTaskOptInAppModule,
        imports: [AppModule, BrowserTaskSessionModule.forSession(config)],
      }
    : AppModule;
}

/** Before global10mb and generic CORS. Reuse the existing authenticated parser
 * and exact controller preflight, never enlarge the application's other routes. */
export function mountBrowserTaskTransport(
  app: NestExpressApplication,
  server: { host: string; port: string | number },
  config?: BrowserTaskConfiguration,
) {
  if (!config) return;
  if (
    server.host !== '127.0.0.1' ||
    String(server.port) !== '4000' ||
    config.localOrigin !== 'http://127.0.0.1:4000'
  )
    fail();
  const broker = app.get(BrowserTaskBroker),
    parser = browserTaskBodyParser(broker),
    controller = new BrowserTaskController(broker);
  app.use('/browser-task', (req, res, next) => {
    if (!['/claim', '/complete', '/cancel'].includes(req.path))
      return res.status(404).json({ code: 'TASK_ROUTE' });
    if (req.method === 'OPTIONS') return controller.preflight(req, res);
    if (req.method !== 'POST')
      return res.status(405).json({ code: 'TASK_METHOD' });
    return parser(req, res, next);
  });
}
