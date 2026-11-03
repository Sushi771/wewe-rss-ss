import {projectWriterGate} from './collection/project-writer-boundary';
import { NestFactory } from '@nestjs/core';
import { TrpcRouter } from '@server/trpc/trpc.router';
import { ConfigService } from '@nestjs/config';
import { json, urlencoded } from 'express';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigurationType } from './configuration';
import { join } from 'path';
import { readFileSync } from 'fs';
import { assertPrivateConfig, privateAccessGuard } from './private-access';
import {
  startSnapshotsAfterStartupAudit,
  startupAuditHttpGuard,
} from './startup-audit';
import {
  startSqliteSnapshotGuard,
  stopSqliteSnapshotGuard,
} from './collection/sqlite-snapshot-guard';
import {
  readBrowserTaskOptIn,
  browserTaskApplication,
  mountBrowserTaskTransport,
} from './browser-task.opt-in';
import { startSqliteRetentionMaintenance } from './collection/sqlite-retention-maintenance';

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

const packageJson = JSON.parse(
  readFileSync(join(process.cwd(), 'package.json'), 'utf-8'),
);

const appVersion = packageJson.version;
console.log('appVersion: v' + appVersion);

async function bootstrap() {
  assertPrivateConfig();
  projectWriterGate().writerForUrl(process.env.DATABASE_URL, join(process.cwd(), 'prisma')); // Before Nest can initialize DB or schedules.
  const browserOptIn = readBrowserTaskOptIn();
  const app = await NestFactory.create<NestExpressApplication>(
    browserTaskApplication(browserOptIn),
    browserOptIn ? { bodyParser: false } : {},
  );
  const configService = app.get(ConfigService);

  const { host, isProd, port } =
    configService.get<ConfigurationType['server']>('server')!;

  app.use(privateAccessGuard);
  app.use(startupAuditHttpGuard);
  mountBrowserTaskTransport(app, { host, port }, browserOptIn);
  if (process.env.WEWE_ACCEPTANCE_MODE === '1')
    app.use((req, res, next) => {
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'",
      );
      if (req.path === '/proxy/image' || req.query.update)
        return res.status(409).send('隔离测试：在线取文图片及普通更新尚未接通');
      next();
    });
  app.use(json({ limit: '10mb' }));
  app.use(urlencoded({ extended: true, limit: '10mb' }));

  app.useStaticAssets(join(process.cwd(), 'client', 'assets'), {
    prefix: '/dash/assets/',
  });
  app.setBaseViewsDir(join(process.cwd(), 'client'));
  app.setViewEngine('hbs');

  if (isProd) {
    app.enable('trust proxy');
  }

  app.enableCors({
    exposedHeaders: ['authorization'],
  });

  const trpc = app.get(TrpcRouter);
  trpc.applyMiddleware(app);

  await app.listen(port, host);
  // Review planning stays independent of startup/backup capacity write gates.
  let stopRetention: () => void = () => undefined;
  try {
    stopRetention = startSqliteRetentionMaintenance();
  } catch {
    console.warn('[SQLITE_RETENTION_CONFIGURATION_REQUIRES_REVIEW]');
  }
  let closed = false;
  app.getHttpServer().once('close', () => {
    closed = true;
    stopSqliteSnapshotGuard();
    stopRetention();
  });
  process.once('exit', stopSqliteSnapshotGuard);
  process.once('exit', stopRetention);
  // HTTP cached reads remain available while the audit finishes. Only then
  // may the periodic owner establish its new recovery generation at this root.
  await startSnapshotsAfterStartupAudit(async () => {
    if (!closed) await startSqliteSnapshotGuard();
  });

  console.log(`Server is running at http://${host}:${port}`);
}
bootstrap();
