import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { XhsWholeCreatorService } from './xhs-whole-creator.service';
import { XhsSubscriptionService } from './xhs-subscription.service';
import { splitSqliteStatements } from '../../../../scripts/sqlite-statements.cjs';
import { projectWriterGate } from './project-writer-boundary';
// ZIP export is unrelated to startup; Jest's CommonJS runner cannot load its ESM dependency.
jest.mock('../offline-archive', () => ({ archiveDirectory: jest.fn() }));

it.each([true, false, 'shutdown'] as const)('starts real Nest during audit and applies recovery only when ready: %s', async (auditOk) => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'xhs-nest-repro-'));
  const previousDir = process.cwd(), previous = { ...process.env };
  // Load the actual checked-out boundary before moving runtime artifacts to Temp.
  const gate = projectWriterGate();
  process.chdir(dir);
  process.env.DATABASE_URL = 'file:' + path.join(dir, 'synthetic.sqlite').replace(/\\/g, '/');
  process.env.NODE_ENV = 'test';
  process.env.WECHAT2RSS_ENABLED = '0';
  process.env.XHS_LIVE_ACCESS_ENABLED = '0';
  const db = new PrismaClient();
  let app: any, appClosed = false;
  try {
    const migrations = path.resolve(__dirname, '../../prisma/migrations');
    for (const name of (await fs.readdir(migrations)).sort()) {
      if (!(await fs.stat(path.join(migrations, name))).isDirectory()) continue;
      for (const sql of splitSqliteStatements(await fs.readFile(path.join(migrations, name, 'migration.sql'), 'utf8'))) await db.$executeRawUnsafe(sql);
    }
    await db.xhsCreator.create({data:{id:'synthetic',externalAuthorId:'synthetic',profileUrl:'https://example.invalid/',displayName:'Synthetic'}});
    const doc = JSON.stringify({id:'job',creatorId:'synthetic',state:'running',sourceFence:{state:'started',marker:'synthetic'}});
    await db.$executeRaw`INSERT INTO xhs_whole_creator_jobs(id,creator_id,state,document,updated_at) VALUES('job','synthetic','running',${doc},1)`;
    const paused = JSON.stringify({id:'paused',creatorId:'synthetic',state:'paused',sourceFence:{state:'started',marker:'unknown'},code:'XHS_DOWNLOAD_BLOCKED'});
    await db.$executeRaw`INSERT INTO xhs_whole_creator_jobs(id,creator_id,state,document,updated_at) VALUES('paused','synthetic','paused',${paused},1)`;
    const child = JSON.stringify({taskId:'child',creatorId:'synthetic',kind:'download',state:'running',total:1,completed:0,skipped:0,failed:0,remaining:1,noteIds:['synthetic-note'],items:{}});
    await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES('child','synthetic','running',${child},1)`;
    let resolveAudit!: (ok:boolean) => void;
    const audit = { status:'verifying', ready:new Promise<boolean>((resolve) => { resolveAudit = resolve; }) };
    (globalThis as any).__weweStartupAudit = audit;
    const { NestFactory } = await import('@nestjs/core');
    const { AppModule } = await import('../app.module');
    app = await NestFactory.create(AppModule, { logger:false, abortOnError:false });
    await app.listen(0, '127.0.0.1');
    const before = await db.$queryRawUnsafe<Array<{state:string}>>("SELECT state FROM xhs_whole_creator_jobs WHERE id='job'");
    expect(before[0].state).toBe('running');
    const whole = app.get(XhsWholeCreatorService);
    await expect((whole as any).readyForMutation()).rejects.toMatchObject({status:503});
    if (auditOk === 'shutdown') {
      await app.close(); appClosed = true;
      audit.status = 'ready'; resolveAudit(true);
      await expect((whole as any).startupRecovery).rejects.toThrow('XHS_TASK_STATE_CHANGED');
      const unchanged = await db.$queryRawUnsafe<Array<{state:string}>>("SELECT state FROM xhs_whole_creator_jobs WHERE id='job'");
      expect(unchanged[0].state).toBe('running');
      return;
    }
    audit.status = auditOk ? 'ready' : 'failed'; resolveAudit(auditOk);
    if (auditOk) {
      await (whole as any).readyForMutation();
      await (app.get(XhsSubscriptionService) as any).readyForMutation();
    }
    else await expect((whole as any).readyForMutation()).rejects.toMatchObject({status:503});
    const after = await db.$queryRawUnsafe<Array<{state:string; document:string}>>("SELECT state,document FROM xhs_whole_creator_jobs WHERE id='job'");
    expect(after[0].state).toBe(auditOk ? 'paused' : 'running');
    expect(JSON.parse(after[0].document).sourceFence).toEqual({state:'started',marker:'synthetic'});
    const retained = await db.$queryRawUnsafe<Array<{document:string}>>("SELECT document FROM xhs_whole_creator_jobs WHERE id='paused'");
    expect(retained[0].document).toBe(paused);
    const childAfter = await db.$queryRawUnsafe<Array<{state:string}>>("SELECT state FROM xhs_subscription_tasks WHERE id='child'");
    expect(childAfter[0].state).toBe(auditOk ? 'blocked' : 'running');
  } finally {
    if (app) {
      if (!appClosed) await app.close();
      await app.get(PrismaService).$disconnect();
    }
    delete (globalThis as any).__weweStartupAudit;
    await db.$disconnect();
    gate.writerForUrl(process.env.DATABASE_URL)?.close();
    process.chdir(previousDir);
    process.env = previous;
    await fs.rm(dir, {recursive:true,force:true});
  }
}, 60000);
