const assert = require('node:assert/strict');
const seams = require('./fixtures/xhs-original-link-router-seams.json');
// Reverse only exact reviewed PC-link/budget additions before legacy baseline pins.
module.exports = function restorePreOriginalLinkRouter(source) {
  for (const {before,after} of seams) {
    assert.equal(source.split(after).length,2,'exact PC-link router seam; changed implementation requires review');
    source=source.replace(after,before);
  }
  return source;
};
