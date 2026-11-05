const assert=require('node:assert/strict'),seams=require('./fixtures/legacy-writer-seams.json');
module.exports=function restoreLegacyWriter(file,source){
 for(const seam of seams[file]||[]){assert.equal(source.split(seam.after).length,2,'exact candidate legacy writer seam');source=source.replace(seam.after,seam.before);}
 return source;
};
