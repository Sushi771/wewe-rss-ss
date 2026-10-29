const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function loadLegacyMaintenance(release,manifest,jobId){
 if(!/^[a-zA-Z0-9_-]{1,128}$/.test(jobId))throw Error('LEGACY_MAINTENANCE_JOB_REQUIRED');
 const root=fs.realpathSync.native(release),relative='server/legacy-maintenance.cjs',file=path.join(root,relative),stat=fs.lstatSync(file);
 const resolved=fs.realpathSync.native(file),inside=path.relative(root,resolved);
 if(!stat.isFile()||stat.isSymbolicLink()||inside.startsWith('..')||path.isAbsolute(inside)||manifest.files?.[relative]!==hash(file)||manifest.files?.['project-writer-gate.cjs']!==hash(path.join(root,'project-writer-gate.cjs'))||manifest.files['project-writer-gate.cjs']!==hash(path.join(__dirname,'project-writer-gate.cjs')))throw Error('LEGACY_MAINTENANCE_ENTRY_UNPROVEN');
 require('./project-writer-gate.cjs');
 const entry=require(file);if(typeof entry.recordLegacyProjectMaintenance!=='function')throw Error('LEGACY_MAINTENANCE_ENTRY_UNPROVEN');
 return checkpoint=>entry.recordLegacyProjectMaintenance(checkpoint,jobId);
}
module.exports={loadLegacyMaintenance};
