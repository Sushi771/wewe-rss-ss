const assert = require('node:assert/strict');

/** Maintenance-only: call after backup/owner stop and exact-source media validation.
 * One SQLite UPDATE is atomic, including constraints/trigger failures. Avoid an
 * interactive ORM transaction whose deadline includes serializing large HTML.
 * expected uses raw SQLite values, preserving nullable timestamps and sources.
 */
function saveMediaCas(database, expected, contentHtml, status) {
  for (const key of [
    'id',
    'mp_id',
    'updated_at',
    'content_html',
    'source_url',
    'verified_source_url',
    'last_body_status',
  ])
    assert.ok(Object.hasOwn(expected, key), `Missing CAS field: ${key}`);
  assert.equal(typeof contentHtml, 'string');
  assert.ok(['available', 'images-pending'].includes(status));
  if (contentHtml === expected.content_html) return 0;
  const result = database
    .prepare(
      `
    UPDATE articles SET content_html = ?, last_body_status = ?, updated_at = ?
    WHERE id = ? AND mp_id = ? AND updated_at IS ? AND content_html IS ?
      AND source_url IS ? AND verified_source_url IS ? AND last_body_status IS ?
  `,
    )
    .run(
      contentHtml,
      status,
      Date.now(),
      expected.id,
      expected.mp_id,
      expected.updated_at,
      expected.content_html,
      expected.source_url,
      expected.verified_source_url,
      expected.last_body_status,
    );
  if (Number(result.changes) !== 1) throw new Error('SAVED_MEDIA_CAS_CONFLICT');
  return 1;
}

module.exports = { saveMediaCas };
