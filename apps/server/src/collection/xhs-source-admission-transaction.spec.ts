import { PrismaClient } from '@prisma/client';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { PrismaService } from '../prisma/prisma.service';
import { incrementalWrite,assertIncrementalTransaction,assertIncrementalWriteAdmission,withIncrementalTransactionChecks,canReuseIncrementalTransactionChecks } from './incremental-write';
import { sqliteWrites } from './sqlite-write-coordinator';
import { configureXhsSourceBudget } from './xhs-source-request-policy';

it('bounds transaction-time checks while preserving rollback on final disk check failure',async()=>{
 const dir=await fs.mkdtemp(path.join(tmpdir(),'xhs-admission-')),file=path.join(dir,'synthetic.sqlite'),url='file:'+file.replace(/\\/g,'/');
 const seed=new PrismaClient({datasources:{db:{url}}});await seed.$executeRawUnsafe('CREATE TABLE fixture(id INTEGER PRIMARY KEY)');await seed.$disconnect();
 const oldUrl=process.env.DATABASE_URL,api=Symbol.for('wewe.project-writer-api.v1'),oldApi=(globalThis as any)[api];process.env.DATABASE_URL=url;(globalThis as any)[api]={writerForUrl:()=>({check(){}})};
 const db=new PrismaService();const original=fs.statfs.bind(fs);let inTx=false,checks=0,failFinal=false;let releaseDetached!:()=>void;let detached!:Promise<boolean>;
 const spy=jest.spyOn(fs,'statfs').mockImplementation((async(...args:any[])=>{if(inTx){checks++;if(failFinal&&checks===2)throw Error('synthetic-disk-check-failed');await new Promise(r=>setTimeout(r,1100));}return (original as any)(...args);}) as any);
 const run=(id:number)=>incrementalWrite(db,8192,()=>sqliteWrites.write(async()=>{await assertIncrementalWriteAdmission();return db.$transaction(async tx=>{inTx=true;try{return await withIncrementalTransactionChecks(async()=>{await assertIncrementalTransaction(tx);if(id===1)detached=new Promise<void>(r=>releaseDetached=r).then(()=>canReuseIncrementalTransactionChecks());await tx.$executeRawUnsafe('INSERT INTO fixture VALUES('+id+')');await tx.$queryRawUnsafe('SELECT 1');await tx.$queryRawUnsafe('SELECT 1');});}finally{inTx=false;}});}));
 try{await run(1);expect(checks).toBe(2);releaseDetached();expect(await detached).toBe(false);let rows=await db.$queryRawUnsafe<Array<{id:number}>>('SELECT id FROM fixture');expect(rows.map(x=>x.id)).toEqual([1]);checks=0;failFinal=true;await expect(run(2)).rejects.toThrow('synthetic-disk-check-failed');rows=await db.$queryRawUnsafe<Array<{id:number}>>('SELECT id FROM fixture');expect(rows.map(x=>x.id)).toEqual([1]);}finally{spy.mockRestore();await db.$disconnect();if(oldUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=oldUrl;if(oldApi===undefined)delete (globalThis as any)[api];else (globalThis as any)[api]=oldApi;await fs.rm(dir,{recursive:true,force:true});}
},40000);

it('executes the actual source budget writer with bounded transaction checks',async()=>{
 const dir=await fs.mkdtemp(path.join(tmpdir(),'xhs-budget-writer-')),file=path.join(dir,'synthetic.sqlite'),url='file:'+file.replace(/\\/g,'/');
 const seed=new PrismaClient({datasources:{db:{url}}});await seed.$executeRawUnsafe('CREATE TABLE xhs_request_budgets(id TEXT PRIMARY KEY,request_limit INTEGER,used INTEGER DEFAULT 0,next_at INTEGER DEFAULT 0,interval_ms INTEGER)');await seed.$disconnect();
 const oldUrl=process.env.DATABASE_URL,api=Symbol.for('wewe.project-writer-api.v1'),oldApi=(globalThis as any)[api];process.env.DATABASE_URL=url;(globalThis as any)[api]={writerForUrl:()=>({check(){}})};
 const db=new PrismaService(),originalTx=db.$transaction.bind(db),originalStat=fs.statfs.bind(fs);let inTx=false,checks=0;
 (db as any).$transaction=(work:any,...options:any[])=>(originalTx as any)(async(tx:any)=>{inTx=true;try{return await work(tx)}finally{inTx=false}},...options);
 const spy=jest.spyOn(fs,'statfs').mockImplementation((async(...args:any[])=>{if(inTx){checks++;await new Promise(r=>setTimeout(r,1100));}return (originalStat as any)(...args);}) as any);
 try{await configureXhsSourceBudget(db as any,{purpose:'resolution'},100,1000);expect(checks).toBe(2);const rows=await db.$queryRawUnsafe<Array<{n:bigint}>>('SELECT count(*) AS n FROM xhs_request_budgets');expect(Number(rows[0].n)).toBe(2);}finally{spy.mockRestore();await db.$disconnect();if(oldUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=oldUrl;if(oldApi===undefined)delete (globalThis as any)[api];else (globalThis as any)[api]=oldApi;await fs.rm(dir,{recursive:true,force:true});}
},40000);
