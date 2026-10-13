'use strict';
// Local files only. No network, database, note-content reconstruction or merges.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const inside = (root, target) => {
  const r = path.relative(root, target);
  return !path.isAbsolute(r) && r !== '..' && !r.startsWith('..' + path.sep);
};
async function ordinary(target, directory) {
  const stat = await fs.lstat(target);
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile())
  )
    throw Error('UNSAFE_LOCAL_PATH');
  return stat;
}
async function tree(root) {
  await ordinary(root, true);
  const files = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw Error('UNSAFE_LOCAL_PATH');
    if (entry.isDirectory()) files.push(...(await tree(full)));
    else {
      await ordinary(full, false);
      files.push(full);
    }
  }
  return files;
}
const references = (text) => [
  ...text.matchAll(/(!?\[[^\]\r\n]*\]\()([^\)\r\n]*)(\))/g),
];
function decoded(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
async function audit(root, vault) {
  root = path.resolve(root);
  vault = path.resolve(vault);
  if (
    !inside(vault, root) ||
    root === vault ||
    (await fs.realpath(root)) !== root ||
    (await fs.realpath(vault)) !== vault
  )
    throw Error('ROOT_NOT_CONFIRMED');
  const files = await tree(root);
  const rootNotes = files.filter(
    (f) => path.dirname(f) === root && /\.md$/i.test(f),
  );
  const allNotes = (await tree(vault)).filter((f) => /\.md$/i.test(f));
  const poolFiles = new Set(
    files.filter((f) => path.dirname(f) === path.join(root, 'attachments')),
  );
  const inbound = new Set();
  let externalPoolReferences = 0;
  for (const f of allNotes) {
    const text = await fs.readFile(f, 'utf8');
    for (const source of rootNotes) {
      if (f === source) continue;
      const stem = path.basename(source, '.md');
      // Preserve bare-name wikilinks via a same-name redirect in the article
      // folder. Explicit old-path links are ambiguous: leave that note in place.
      for (const match of text.matchAll(/\[\[([^\]]+)\]\]/g)) {
        const rawTarget = match[1].split('|')[0];
        const target = decoded(match[1].split('|')[0].split('#')[0]).replace(
          /\\/g,
          '/',
        );
        if (
          target.includes('/') &&
          (target.endsWith('/' + stem) || target.endsWith('/' + stem + '.md'))
        )
          inbound.add(source);
        if (
          (target === stem || target === stem + '.md') &&
          (rawTarget.includes('#') ||
            allNotes.some(
              (n) =>
                n !== source &&
                path.basename(n).toLowerCase() ===
                  path.basename(source).toLowerCase(),
            ))
        )
          inbound.add(source);
      }
      for (const match of references(text)) {
        const target = decoded(match[2]).split('#')[0];
        if (
          path.resolve(path.dirname(f), target) === source ||
          (target.startsWith('obsidian://') && target.includes(stem))
        )
          inbound.add(source);
      }
    }
    if (!rootNotes.includes(f)) {
      const targets = [
        ...references(text).map((m) => m[2]),
        ...[...text.matchAll(/\[\[([^\]]+)\]\]/g)].map(
          (m) => m[1].split('|')[0],
        ),
        ...[...text.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)].map(
          (m) => m[1],
        ),
      ];
      if (
        targets.some((raw) => {
          const target = decoded(raw).split('#')[0].replace(/\\/g, '/');
          return (
            poolFiles.has(path.resolve(path.dirname(f), target)) ||
            poolFiles.has(path.resolve(vault, target))
          );
        })
      )
        externalPoolReferences++;
    }
  }
  // File bookmarks require the old path. Do not silently break or edit them.
  const bookmarks = path.join(vault, '.obsidian', 'bookmarks.json');
  try {
    await ordinary(bookmarks, false);
    const raw = await fs.readFile(bookmarks, 'utf8');
    const visit = (obj) => {
      if (!obj || typeof obj !== 'object') return;
      if (typeof obj.path === 'string') {
        const destination = path.resolve(vault, obj.path);
        if (rootNotes.includes(destination)) inbound.add(destination);
      }
      Object.values(obj).forEach(visit);
    };
    visit(JSON.parse(raw));
  } catch (error) {
    if (error.code !== 'ENOENT') throw Error('BOOKMARKS_NOT_VERIFIABLE');
  }
  const items = [],
    skipped = [];
  for (const source of rootNotes) {
    const bytes = await fs.readFile(source),
      text = bytes.toString('utf8');
    const identity = /(WX_\d{5,15}_\d+_[1-9]\d*)\.md$/.exec(
      path.basename(source),
    );
    if (
      !identity ||
      text.includes('\uFFFD') ||
      inbound.has(source) ||
      /\[\[(?:\.\.?[\\/])/.test(text)
    ) {
      skipped.push({
        name: path.basename(source),
        reason: inbound.has(source)
          ? 'explicit-inbound-link'
          : 'unverified-note-or-relative-wikilink',
      });
      continue;
    }
    const refs = references(text),
      media = [];
    let unsafe = false;
    for (const ref of refs) {
      const target = decoded(ref[2]);
      if (/^(?:https?:|data:|#|obsidian:)/.test(target)) continue;
      if (
        !/^attachments\/image_[a-f0-9]{32}\.(?:png|jpe?g|gif|webp)$/.test(
          target,
        )
      ) {
        unsafe = true;
        break;
      }
      const image = path.join(root, target);
      await ordinary(image, false);
      media.push({
        source: image,
        name: path.basename(image),
        hash: hash(await fs.readFile(image)),
      });
    }
    if (unsafe || !media.length) {
      skipped.push({
        name: path.basename(source),
        reason: 'unsupported-local-reference',
      });
      continue;
    }
    const name = path.basename(source, '.md');
    let folder = name,
      suffix = 1;
    while (
      files.some((f) => inside(path.join(root, folder), f)) ||
      (await fs.lstat(path.join(root, folder)).then(
        () => true,
        () => false,
      ))
    )
      folder = name + ' (整理 ' + suffix++ + ')';
    const markdown = text.replace(
      /(\]\()attachments\/(image_[a-f0-9]{32}\.(?:png|jpe?g|gif|webp)\))/g,
      '$1image/$2',
    );
    if (/attachments[\\/]|attachments%2[fF]/.test(markdown)) {
      skipped.push({
        name: path.basename(source),
        reason: 'unsupported-attachment-reference',
      });
      continue;
    }
    items.push({
      source,
      name: path.basename(source),
      folder,
      articleId: identity[1],
      originalHash: hash(bytes),
      markdown,
      media: [...new Map(media.map((m) => [m.name, m])).values()],
      imageReferences: media.length,
    });
  }
  return { root, vault, files, items, skipped, externalPoolReferences };
}
async function migrate({ root, vault, backup }) {
  const plan = await audit(root, vault);
  backup = path.resolve(backup);
  if (
    inside(plan.vault, backup) ||
    inside(backup, plan.vault) ||
    backup === path.parse(backup).root
  )
    throw Error('BACKUP_MUST_BE_OUTSIDE_VAULT');
  if ((await fs.realpath(path.dirname(backup))) !== path.dirname(backup))
    throw Error('UNSAFE_BACKUP_PARENT');
  await fs.mkdir(backup, { recursive: false });
  const snapshot = path.join(backup, 'snapshot');
  await fs.mkdir(snapshot);
  const manifest = [];
  for (const file of plan.files) {
    const relative = path.relative(plan.root, file),
      bytes = await fs.readFile(file),
      to = path.join(snapshot, relative);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.writeFile(to, bytes, { flag: 'wx' });
    if (hash(await fs.readFile(to)) !== hash(bytes))
      throw Error('BACKUP_VERIFY_FAILED');
    manifest.push({ relative, sha256: hash(bytes), bytes: bytes.length });
  }
  await fs.writeFile(
    path.join(backup, 'manifest.json'),
    JSON.stringify({ root: plan.root, files: manifest }, null, 2),
    { flag: 'wx' },
  );
  const completed = [];
  for (const item of plan.items) {
    if (hash(await fs.readFile(item.source)) !== item.originalHash)
      throw Error('NOTE_CHANGED_DURING_REPAIR');
    const folder = path.join(plan.root, item.folder),
      images = path.join(folder, 'image');
    await fs.mkdir(folder);
    await fs.mkdir(images);
    for (const media of item.media) {
      if ((await fs.realpath(media.source)) !== media.source)
        throw Error('UNSAFE_LOCAL_PATH');
      if (hash(await fs.readFile(media.source)) !== media.hash)
        throw Error('IMAGE_CHANGED_DURING_REPAIR');
      const to = path.join(images, media.name);
      await fs.copyFile(media.source, to, constants.COPYFILE_EXCL);
      if (hash(await fs.readFile(to)) !== media.hash)
        throw Error('IMAGE_COPY_VERIFY_FAILED');
    }
    const note = path.join(folder, '正文.md');
    await fs.writeFile(note, item.markdown, { flag: 'wx' });
    if ((await fs.readFile(note, 'utf8')) !== item.markdown)
      throw Error('NOTE_COPY_VERIFY_FAILED');
    for (const ref of references(item.markdown))
      if (ref[2].startsWith('image/'))
        await ordinary(path.join(folder, ref[2]), false);
    // Same original basename keeps existing bare-name Obsidian links usable.
    await fs.writeFile(
      path.join(folder, item.name),
      '[打开已整理正文](./正文.md)\n',
      { flag: 'wx' },
    );
    await fs.writeFile(
      path.join(folder, '.wewe-layout-migration.json'),
      JSON.stringify(
        {
          originalName: item.name,
          originalSha256: item.originalHash,
          articleId: item.articleId,
          images: item.media.map((m) => ({ name: m.name, sha256: m.hash })),
          backup,
        },
        null,
        2,
      ),
      { flag: 'wx' },
    );
    // Originals are moved into the verified backup, never deleted or overwritten.
    const retired = path.join(backup, 'originals');
    await fs.mkdir(retired, { recursive: true });
    if (hash(await fs.readFile(item.source)) !== item.originalHash)
      throw Error('NOTE_CHANGED_DURING_REPAIR');
    await fs.rename(item.source, path.join(retired, item.name));
    completed.push({
      name: item.name,
      folder: item.folder,
      images: item.media.length,
      imageReferences: item.imageReferences,
    });
  }
  let attachmentsRetired = false;
  if (
    plan.items.length &&
    !plan.skipped.length &&
    !plan.externalPoolReferences
  ) {
    const pool = path.join(plan.root, 'attachments');
    const retiredPool = path.join(backup, 'originals', 'attachments');
    if (
      !inside(plan.root, pool) ||
      !inside(backup, retiredPool) ||
      (await fs.realpath(pool)) !== pool
    )
      throw Error('UNSAFE_LOCAL_PATH');
    // Recheck against the full byte manifest before moving a shared directory.
    const poolFiles = await tree(pool);
    for (const file of poolFiles) {
      const expected = manifest.find(
        (m) => m.relative === path.relative(plan.root, file),
      );
      if (!expected || hash(await fs.readFile(file)) !== expected.sha256)
        throw Error('POOL_CHANGED_DURING_REPAIR');
    }
    await fs.rename(pool, retiredPool);
    attachmentsRetired = true;
  }
  const result = {
    backup,
    backedUpFiles: manifest.length,
    completed,
    skipped: plan.skipped,
    externalPoolReferences: plan.externalPoolReferences,
    attachmentsRetired,
  };
  await fs.writeFile(
    path.join(backup, 'result.json'),
    JSON.stringify(result, null, 2),
    { flag: 'wx' },
  );
  return result;
}
module.exports = { audit, migrate };
if (require.main === module) {
  const [root, vault, backup, flag] = process.argv.slice(2);
  (flag === '--apply'
    ? migrate({ root, vault, backup })
    : audit(root, vault).then((p) => ({
        planned: p.items.map((i) => ({
          name: i.name,
          folder: i.folder,
          images: i.media.length,
          imageReferences: i.imageReferences,
        })),
        skipped: p.skipped,
        externalPoolReferences: p.externalPoolReferences,
      }))
  )
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    });
}
