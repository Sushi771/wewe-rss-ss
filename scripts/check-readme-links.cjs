'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
function checkTarget(target, file, root = process.cwd()) {
  target = decodeURIComponent(target.split('#')[0].split('?')[0]);
  if (!target) return;
  const fixed = target.match(
    /^https:\/\/github.com\/Sushi771\/wewe-rss-ss\/blob\/([0-9a-f]{40})\/(.+)$/,
  );
  if (fixed) {
    const files = execFileSync(
      'git',
      ['ls-tree', '-r', '--name-only', fixed[1]],
      { cwd: root, encoding: 'utf8' },
    ).split('\n');
    if (!files.includes(fixed[2]))
      throw Error(`${file}: missing fixed target ${target}`);
    return;
  }
  if (/^[a-z]+:/i.test(target) || target.startsWith('//')) return;
  const full = path.resolve(root, path.dirname(file), target);
  if (!full.startsWith(root + path.sep))
    throw Error('target escapes repository');
  let current = root;
  for (const part of path.relative(root, full).split(path.sep)) {
    if (!fs.readdirSync(current).includes(part))
      throw Error(`${file}: missing or wrong-case ${target}`);
    current = path.join(current, part);
  }
}
function check(files) {
  let count = 0;
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const targets = [
      ...source.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g),
      ...source.matchAll(/^\[[^\]]+\]:\s*(\S+)/gm),
    ];
    for (const m of targets) {
      checkTarget(m[1], file);
      count++;
    }
  }
  return count;
}
module.exports = { checkTarget, check };
if (require.main === module)
  console.log(
    `Checked ${check(process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync('.').filter((x) => /^README.*\.md$/.test(x)))} README targets`,
  );
