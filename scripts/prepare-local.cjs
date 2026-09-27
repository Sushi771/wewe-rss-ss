// Called after the old server exits so Prisma's Windows DLL is not locked.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const server = path.join(root, 'apps/server');
const data = path.join(server, 'data');
const stamp = path.join(data, '.local-build-hash');
const hash = crypto.createHash('sha256');
function digest(relative) {
  const target = path.join(root, relative);
  if (!fs.existsSync(target)) return;
  if (fs.statSync(target).isDirectory()) {
    for (const name of fs.readdirSync(target).sort())
      digest(path.join(relative, name));
  } else {
    hash.update(relative);
    hash.update(fs.readFileSync(target));
  }
}
for (const relative of [
  'apps/server/src',
  'apps/server/prisma',
  'apps/web/src',
  'packages/shared/src',
  'package.json',
  'pnpm-lock.yaml',
  'apps/server/package.json',
  'apps/web/package.json',
  'apps/web/vite.config.ts',
  'apps/web/tailwind.config.js',
  'tsconfig.base.json',
  'apps/server/tsconfig.json',
  'apps/web/tsconfig.json',
  'scripts/prepare-local.cjs',
])
  digest(relative);
const version = hash.digest('hex');
const run = (command) =>
  execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], {
    cwd: root,
    stdio: 'inherit',
  });
try {
  const changed =
    !fs.existsSync(stamp) ||
    fs.readFileSync(stamp, 'utf8') !== version ||
    !fs.existsSync(path.join(server, 'dist/apps/server/src/main.js')) ||
    !fs.existsSync(path.join(server, 'client/index.hbs'));
  if (changed) {
    fs.mkdirSync(data, { recursive: true });
    const env = fs.existsSync(path.join(server, '.env'))
      ? fs.readFileSync(path.join(server, '.env'), 'utf8')
      : '';
    const url =
      process.env.DATABASE_URL ||
      env.match(/^\s*DATABASE_URL\s*=\s*["']?([^\r\n"']+)/m)?.[1]?.trim();
    if (url?.startsWith('file:')) {
      const db = path.resolve(server, 'prisma', url.slice(5));
      if (fs.existsSync(db)) {
        const backup = path.join(
          data,
          'backups',
          new Date().toISOString().replace(/[:.]/g, '-'),
        );
        fs.mkdirSync(backup, { recursive: true });
        for (const suffix of ['', '-wal', '-shm'])
          if (fs.existsSync(db + suffix))
            fs.copyFileSync(
              db + suffix,
              path.join(backup, 'wewe-rss.db' + suffix),
            );
        console.log('Database backup:', backup);
      }
    }
    console.log('Preparing updated local application...');
    run('pnpm --filter server exec prisma generate');
    run('pnpm build:server');
    run('pnpm build:web');
  }
  run('pnpm --filter server exec prisma migrate deploy');
  fs.writeFileSync(stamp, version);
} catch {
  console.error(
    'Preparation failed. The server was not started. See the error above.',
  );
  process.exitCode = 1;
}
