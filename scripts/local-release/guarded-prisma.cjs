const fs = require('node:fs'), path = require('node:path');
const {createRequire}=require('node:module');
const {spawn}=require('node:child_process');
const gate = require('./project-writer-gate.cjs');
function databaseUrl(server, environment, parse) {
  const values=[path.join(server,'.env'),path.join(server,'prisma/.env')].filter(f=>fs.existsSync(f)).map(f=>parse(fs.readFileSync(f)).DATABASE_URL).filter(v=>v!==undefined);
  if(values.length===2&&values[0]!==values[1])throw Error('PROJECT_WRITER_DATABASE_ENV_CONFLICT');
  const raw=environment.DATABASE_URL??values[0];
  if(typeof raw!=='string'||!raw.startsWith('file:'))throw Error('PROJECT_WRITER_SQLITE_DATABASE_REQUIRED');
  return path.resolve(server,'prisma',decodeURIComponent(raw.slice(5).split('?')[0]));
}
async function runPrisma(args, options={}) {
  if(!['migrate deploy','migrate dev','studio'].includes(args.join(' ')))throw Error('PROJECT_WRITER_CLI_UNSUPPORTED');
  const server=options.server||path.resolve(__dirname,'../../apps/server');
  const req=createRequire(path.join(server,'package.json'));
  const parse=options.parse||createRequire(req.resolve('@nestjs/config'))('dotenv').parse;
  const file=databaseUrl(server,options.env||process.env,parse);
  if(!fs.existsSync(file)){const fd=fs.openSync(file,'wx',0o600);fs.closeSync(fd);}
  const lease=gate.acquireWriter(file);
  lease.retainOnExit(); // A terminated wrapper must not admit another writer while a CLI child may remain.
  try {
    const cli=options.cli||req.resolve('prisma/build/index.js');
    const child=(options.spawn||spawn)(process.execPath,[cli,...args],{cwd:server,env:{...(options.env||process.env),DATABASE_URL:'file:'+lease.database.replace(/\\/g,'/')},stdio:'inherit',windowsHide:true});
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(status,signal)=>signal?reject(Error('PROJECT_WRITER_CLI_INTERRUPTED')):resolve(status));});
    if(code!==0)throw Error('PROJECT_WRITER_CLI_FAILED');
    lease.check();lease.close();
  }catch(error){lease.abandon();throw error;}
}
if(require.main===module)runPrisma(process.argv.slice(2)).catch(()=>{console.error('PROJECT_WRITER_CLI_REQUIRES_REVIEW');process.exitCode=1;});
module.exports={runPrisma,databaseUrl};
