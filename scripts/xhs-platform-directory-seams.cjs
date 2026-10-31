const assert=require('node:assert/strict');
const seams=require('./fixtures/xhs-platform-directory-seams.json');
module.exports=function restorePlatformDirectory(file,source){
 for(const seam of seams[file]||[]){
  assert.equal(source.split(seam.after).length,2,'exact reviewed platform directory seam');
  source=source.replace(seam.after,seam.before);
 }
 return source;
};
