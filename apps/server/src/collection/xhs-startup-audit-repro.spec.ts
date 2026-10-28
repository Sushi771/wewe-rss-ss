import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { PrismaService } from '../prisma/prisma.service';
import { PrismaClient } from '@prisma/client';
import { XhsWholeCreatorService } from './xhs-whole-creator.service';
import { splitSqliteStatements } from '../../../../scripts/sqlite-statements.cjs';

it('defers the actual whole-creator hook under the startup write gate', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'xhs-audit-repro-'));
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'file:' + path.join(dir, 'synthetic.sqlite').replace(/\\/g, '/');
  const db = new PrismaService();
  try {
    const migrations = path.resolve(__dirname, '../../prisma/migrations');
    for (const name of (await fs.readdir(migrations)).sort()) {
      if (!(await fs.stat(path.join(migrations, name))).isDirectory()) continue;
      for (const sql of splitSqliteStatements(await fs.readFile(path.join(migrations, name, 'migration.sql'), 'utf8'))) await db.$executeRawUnsafe(sql);
    }
    await db.xhsCreator.create({data:{id:'synthetic',externalAuthorId:'synthetic',profileUrl:'https://example.invalid/',displayName:'Synthetic'}});
    const doc = JSON.stringify({id:'job',creatorId:'synthetic',state:'running',sourceFence:{state:'started',marker:'synthetic'}});
    await db.$executeRaw`INSERT INTO xhs_whole_creator_jobs(id,creator_id,state,document,updated_at) VALUES('job','synthetic','running',${doc},1)`;
    (globalThis as any).__weweStartupAudit = { status:'verifying', ready:Promise.resolve(false) };
    const whole = new XhsWholeCreatorService(db, {} as any, {} as any, {} as any);
    await expect(whole.onModuleInit()).resolves.toBeUndefined();
    const reader = new PrismaClient();
    try {
      const rows = await reader.$queryRawUnsafe<Array<{state:string}>>("SELECT state FROM xhs_whole_creator_jobs WHERE id='job'");
      expect(rows[0].state).toBe('running');
    } finally { await reader.$disconnect(); }
  } finally {
    delete (globalThis as any).__weweStartupAudit;
    await db.$disconnect();
    if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous;
    await fs.rm(dir, {recursive:true,force:true});
  }
}, 40000);
