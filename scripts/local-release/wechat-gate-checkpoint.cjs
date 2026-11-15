'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
function privateDir(dir){
 const real=fs.realpathSync(dir), st=fs.lstatSync(dir);
 if(!st.isDirectory()||st.isSymbolicLink()||path.resolve(real).toLowerCase()!==path.resolve(dir).toLowerCase())throw Error('WECHAT_PRIVATE_DIRECTORY_INVALID');
 const script="$a=Get-Acl -LiteralPath $env:WECHAT_RECORD_DIR; $s=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; if(!$a.AreAccessRulesProtected -or $a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $s -or @($a.Access | Where-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $s }).Count -ne 0){exit 2}";
 cp.execFileSync('pwsh.exe',['-NoProfile','-NonInteractive','-Command',script],{env:{...process.env,WECHAT_RECORD_DIR:real},windowsHide:true,stdio:'ignore'}); return real;
}
function recordWechatGate(checkpoint,dir,api=globalThis[Symbol.for('wewe.project-writer-api.v1')],open=(p,o)=>new DatabaseSync(p,o)){
 const {identity,stopReceipt,scopeLease,database,observeProjectWriters}=checkpoint;
 if(!api||!identity||!stopReceipt||stopReceipt.stopped!==true||['pid','startUtc','executable','commandLine'].some(k=>identity[k]!==stopReceipt[k]))throw Error('WECHAT_CHECKPOINT_UNPROVEN');
 const boundary=scopeLease.legacyMaintenanceBoundary(identity,observeProjectWriters);
 const claim={...scopeLease,check:()=>boundary.check(),assertLegacyMaintenanceLease:()=>boundary.check()};
 const lease=api.acquireMaintenance(database,{...checkpoint,scopeLease:claim});
 let db,committing=false,original,record,expected;
 const check=()=>{lease.check();boundary.check();boundary.observe();};
 try{
  check(); const directory=privateDir(dir); check();
  db=open(database,{timeout:1000}); db.exec('BEGIN IMMEDIATE'); check();
  original=db.prepare('SELECT state,token,status FROM Wechat2RssSourceGate WHERE id=1').get();
  if(!original||original.state!=='pending'||typeof original.token!=='string'||!original.token||original.status!==null)throw Error('WECHAT_GATE_PRECONDITION');
  const unknown=db.prepare("SELECT count(*) AS n FROM refresh_submission_claims WHERE state='unknown'").get().n;
  const articles=db.prepare('SELECT count(*) AS n FROM articles').get().n;
  const payload=JSON.stringify({version:1,result:'unknown',original,unknown,articles});
  expected=payload;
  record=path.join(directory,'wechat-pending-recovery.json'); const fd=fs.openSync(record,'wx',0o600);
  try{fs.writeFileSync(fd,payload);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
  if(fs.readFileSync(record,'utf8')!==payload)throw Error('WECHAT_RECORD_VERIFY_FAILED');
  check(); const result=db.prepare("UPDATE Wechat2RssSourceGate SET state='idle',token=NULL,status=NULL WHERE id=1 AND state='pending' AND token=? AND status IS NULL").run(original.token);
  if(Number(result.changes)!==1)throw Error('WECHAT_GATE_CHANGED');
  check(); committing=true; db.exec('COMMIT'); committing=false;
  return {outcome:'committed',record};
 }catch(e){
  if(db){try{db.exec('ROLLBACK')}catch{} db.close();db=undefined}
  if(committing){
   let ro;
   try{
    if(fs.readFileSync(record,'utf8')!==expected)throw Error('RECORD_CHANGED');
    ro=open(database,{readOnly:true,timeout:1000});
    const row=ro.prepare('SELECT state,token,status FROM Wechat2RssSourceGate WHERE id=1').get();
    const u=ro.prepare("SELECT count(*) AS n FROM refresh_submission_claims WHERE state='unknown'").get().n;
    const a=ro.prepare('SELECT count(*) AS n FROM articles').get().n;
    const saved=JSON.parse(expected);
    if(u!==saved.unknown||a!==saved.articles)throw Error('DATA_CHANGED');
    if(row.state==='idle'&&row.token===null&&row.status===null)return {outcome:'committed-verified',record};
    if(row.state===original.state&&row.token===original.token&&row.status===original.status)throw Error('WECHAT_NOT_COMMITTED_VERIFIED');
    throw Error('STATE_CHANGED');
   }catch(readError){if(readError.message==='WECHAT_NOT_COMMITTED_VERIFIED')throw readError;throw Error('WECHAT_COMMIT_OUTCOME_UNKNOWN')}
   finally{if(ro)ro.close()}
  }
  throw e;
 }finally{if(db)db.close();lease.close()}
}
module.exports={recordWechatGate};

