// 从固定旧源码构建静态页面；通过已安装 Vite 的 Node API 避开深层 junction 的配置打包失败。
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

async function buildLegacyWeb(sourceWeb, output) {
  const outputDir = path.resolve(output);
  sourceWeb = fs.realpathSync(sourceWeb);
  const currentWeb = path.resolve(__dirname, '../../apps/web');
  const installed = createRequire(path.join(currentWeb, 'package.json'));
  const { build } = installed('vite');
  const react = installed('@vitejs/plugin-react').default;
  const tailwindcss = installed('tailwindcss');
  const autoprefixer = installed('autoprefixer');
  const projectRoot = path.resolve(sourceWeb, '../..');
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(sourceWeb, 'package.json'), 'utf8'),
  );
  // Tailwind 的 content 相对 cwd 展开，必须与旧版 Vite CLI 一样从旧 web 目录构建。
  process.chdir(sourceWeb);
  await build({
    configFile: false,
    root: sourceWeb,
    base: '/dash',
    mode: 'production',
    css: {
      postcss: {
        plugins: [
          tailwindcss({ config: path.join(sourceWeb, 'tailwind.config.ts') }),
          autoprefixer(),
        ],
      },
    },
    define: { __APP_VERSION__: JSON.stringify(packageJson.version) },
    plugins: [
      react(),
      {
        name: 'renameIndex',
        enforce: 'post',
        generateBundle(_options, bundle) {
          bundle['index.html'].fileName = 'index.hbs';
        },
      },
    ],
    resolve: {
      alias: [
        {
          find: '@server',
          replacement: path.join(projectRoot, 'apps/server/src'),
        },
        { find: '@web', replacement: path.join(sourceWeb, 'src') },
        {
          find: '@wewe-rss/shared',
          replacement: path.join(projectRoot, 'packages/shared/src'),
        },
      ],
    },
    build: { outDir: outputDir, emptyOutDir: true },
  });
}

if (require.main === module)
  buildLegacyWeb(process.argv[2], process.argv[3]).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
module.exports = { buildLegacyWeb };
