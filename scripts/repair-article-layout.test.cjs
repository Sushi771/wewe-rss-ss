'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os');
const { audit, migrate } = require('./repair-article-layout.cjs');
const image = 'image_' + 'a'.repeat(32) + '.png';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
  'base64',
);
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-layout-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const vault = path.join(base, 'vault'),
    root = path.join(vault, '2026-10-10'),
    backup = path.join(base, 'backup');
  await fs.mkdir(path.join(root, 'attachments'), { recursive: true });
  await fs.writeFile(path.join(root, 'attachments', image), png);
  const name = '保留编辑-WX_1234567890_2247000001_1.md',
    body = '# 用户编辑原样\r\n\r\n![图](attachments/' + image + ')\r\n';
  await fs.writeFile(path.join(root, name), body);
  return { base, vault, root, backup, name, body };
}
test('verified backup precedes isolation, body edits survive and original-basename wikilinks retain an entry', async (t) => {
  const f = await fixture(t);
  const external = path.join(f.vault, '其他笔记.md');
  await fs.writeFile(external, '[[' + f.name.slice(0, -3) + ']]');
  const result = await migrate(f);
  assert.equal(result.completed.length, 1);
  assert.equal(result.attachmentsRetired, true);
  const folder = path.join(f.root, result.completed[0].folder);
  assert.equal(
    await fs.readFile(path.join(folder, '正文.md'), 'utf8'),
    f.body.replace('attachments/', 'image/'),
  );
  assert.deepEqual(await fs.readFile(path.join(folder, 'image', image)), png);
  assert.equal(
    await fs.readFile(path.join(f.backup, 'snapshot', f.name), 'utf8'),
    f.body,
  );
  assert.equal(
    await fs.readFile(path.join(f.backup, 'originals', f.name), 'utf8'),
    f.body,
  );
  assert.ok(
    (await fs.readFile(path.join(folder, f.name), 'utf8')).includes(
      './正文.md',
    ),
  );
  assert.equal(
    await fs.readFile(external, 'utf8'),
    '[[' + f.name.slice(0, -3) + ']]',
  );
  assert.equal(
    (await fs.readdir(f.root)).some(
      (n) => n.endsWith('.md') || n === 'attachments',
    ),
    false,
  );
  assert.equal((await audit(f.root, f.vault)).items.length, 0);
});
test('explicit-path incoming note links leave the original intact instead of rewriting unrelated notes', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    path.join(f.vault, '其他笔记.md'),
    '[[2026-10-10/' + f.name.slice(0, -3) + ']]',
  );
  const result = await migrate(f);
  assert.equal(result.completed.length, 0);
  assert.equal(result.skipped[0].reason, 'explicit-inbound-link');
  assert.equal(await fs.readFile(path.join(f.root, f.name), 'utf8'), f.body);
  assert.equal(result.attachmentsRetired, false);
});
test('existing article folders are never merged or overwritten; shared resources stay when another note uses them', async (t) => {
  const f = await fixture(t);
  const existing = path.join(f.root, f.name.slice(0, -3));
  await fs.mkdir(existing);
  await fs.writeFile(path.join(existing, '正文.md'), '旧版用户编辑');
  await fs.writeFile(
    path.join(f.vault, '其他笔记.md'),
    '![保留](2026-10-10/attachments/' + image + ')',
  );
  const result = await migrate(f);
  assert.equal(result.completed.length, 1);
  assert.notEqual(result.completed[0].folder, path.basename(existing));
  assert.equal(
    await fs.readFile(path.join(existing, '正文.md'), 'utf8'),
    '旧版用户编辑',
  );
  assert.equal(result.attachmentsRetired, false);
  assert.equal(result.externalPoolReferences, 1);
});
test('unsupported resource references and backup paths within the vault are refused without changing original bytes', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    path.join(f.root, f.name),
    f.body + '\n<img src="attachments/' + image + '">',
  );
  const plan = await audit(f.root, f.vault);
  assert.equal(plan.items.length, 0);
  assert.equal(plan.skipped[0].reason, 'unsupported-attachment-reference');
  await assert.rejects(
    migrate({ ...f, backup: path.join(f.vault, 'backup') }),
    /BACKUP_MUST_BE_OUTSIDE_VAULT/,
  );
  assert.equal(
    await fs.readFile(path.join(f.root, f.name), 'utf8'),
    f.body + '\n<img src="attachments/' + image + '">',
  );
});
test('another date attachments pool cannot be mistaken for references to this repair target', async (t) => {
  const f = await fixture(t);
  const other = path.join(f.vault, '2026-10-09');
  await fs.mkdir(path.join(other, 'attachments'), { recursive: true });
  await fs.writeFile(path.join(other, 'attachments', image), png);
  await fs.writeFile(
    path.join(other, '其他日期.md'),
    '![图](attachments/' + image + ')',
  );
  const plan = await audit(f.root, f.vault);
  assert.equal(plan.externalPoolReferences, 0);
  const result = await migrate(f);
  assert.equal(result.attachmentsRetired, true);
  assert.deepEqual(
    await fs.readFile(path.join(other, 'attachments', image)),
    png,
  );
});
test('explicit Obsidian file bookmark keeps its original path without modifying bookmark config', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.vault, '.obsidian'));
  const file = path.join(f.vault, '.obsidian', 'bookmarks.json'),
    text = JSON.stringify({
      items: [{ type: 'file', path: '2026-10-10/' + f.name }],
    });
  await fs.writeFile(file, text);
  const result = await migrate(f);
  assert.equal(result.completed.length, 0);
  assert.equal(await fs.readFile(file, 'utf8'), text);
  assert.equal(await fs.readFile(path.join(f.root, f.name), 'utf8'), f.body);
});

test('bare wikilink heading targets remain at their original note rather than losing the section anchor', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    path.join(f.vault, '其他笔记.md'),
    '[[' + f.name.slice(0, -3) + '#用户编辑原样]]',
  );
  const result = await migrate(f);
  assert.equal(result.completed.length, 0);
  assert.equal(await fs.readFile(path.join(f.root, f.name), 'utf8'), f.body);
});

test('ambiguous bare wikilinks with another same-basename note are skipped without rewriting either version', async (t) => {
  const f = await fixture(t);
  const other = path.join(f.vault, '另一个日期');
  await fs.mkdir(other);
  await fs.writeFile(path.join(other, f.name), '另一篇同名正文');
  await fs.writeFile(path.join(f.vault, '其他笔记.md'), '[[' + f.name + ']]');
  const result = await migrate(f);
  assert.equal(result.completed.length, 0);
  assert.equal(await fs.readFile(path.join(f.root, f.name), 'utf8'), f.body);
  assert.equal(
    await fs.readFile(path.join(other, f.name), 'utf8'),
    '另一篇同名正文',
  );
});
