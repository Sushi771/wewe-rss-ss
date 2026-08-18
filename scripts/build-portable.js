const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const buildDir = path.join(rootDir, 'portable-build');
const outputDir = path.join(buildDir, 'WeWe-RSS-Portable');
const nodeVersion = '20.16.0';
const nodeZipName = `node-v${nodeVersion}-win-x64.zip`;
const cacheZipPath = path.join(buildDir, nodeZipName);
const nodeUrl = `https://nodejs.org/dist/v${nodeVersion}/${nodeZipName}`;
const zipName = 'WeWe-RSS-Portable-v2.6.1.zip';
const zipOutputPath = path.join(rootDir, zipName);

function log(msg) {
  console.log(`\x1b[36m${msg}\x1b[0m`);
}

function runCmd(cmd, cwd = rootDir) {
  log(`> Running: ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit', shell: true });
}

function main() {
  console.log('============================================');
  console.log('  WeWe-RSS 便携包构建工具 (Node.js Engine)');
  console.log('============================================\n');

  // Step 1: Clean build directory
  log('[1/7] 清理旧构建...');
  if (fs.existsSync(outputDir)) {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
  if (!fs.existsSync(buildDir)) {
    fs.mkdirSync(buildDir, { recursive: true });
  }
  fs.mkdirSync(outputDir, { recursive: true });
  console.log('      完成.\n');

  // Step 2: Build project
  log('[2/7] 构建 server 和 web...');
  runCmd('pnpm run build:web');
  runCmd('pnpm run build:server');
  console.log('      完成.\n');

  // Step 3: Export production dependencies
  log('[3/7] 导出生产依赖 (pnpm deploy --prod)...');
  const serverTargetDir = path.join(outputDir, 'server');
  if (fs.existsSync(serverTargetDir)) {
    fs.rmSync(serverTargetDir, { recursive: true, force: true });
  }
  runCmd(`pnpm deploy --legacy --filter=server --prod "${serverTargetDir}"`);

  // Ensure built output and client assets are present in deployment directory
  const sourceServerDir = path.join(rootDir, 'apps', 'server');
  const itemsToCopy = ['client', 'dist', 'prisma'];
  for (const item of itemsToCopy) {
    const srcPath = path.join(sourceServerDir, item);
    const destPath = path.join(serverTargetDir, item);
    if (fs.existsSync(srcPath)) {
      log(`      复制 ${item} ...`);
      fs.cpSync(srcPath, destPath, { recursive: true, force: true });
    }
  }
  console.log('      完成.\n');

  // Step 4: Generate Prisma Client
  log('[4/7] 生成 Prisma Client...');
  runCmd('npx prisma generate', serverTargetDir);
  console.log('      完成.\n');

  // Step 5: Download & Extract Node.js portable
  log(`[5/7] 准备 Node.js v${nodeVersion} 便携版...`);
  if (!fs.existsSync(cacheZipPath)) {
    log(`      正在下载 ${nodeUrl} ...`);
    const psDownload = `powershell -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '${nodeUrl}' -OutFile '${cacheZipPath}' -UseBasicParsing"`;
    execSync(psDownload, { stdio: 'inherit' });
  }

  log('      解压 Node.js...');
  const tmpExtractDir = path.join(buildDir, 'node-tmp');
  if (fs.existsSync(tmpExtractDir)) {
    fs.rmSync(tmpExtractDir, { recursive: true, force: true });
  }
  const psExtract = `powershell -Command "Expand-Archive -Path '${cacheZipPath}' -DestinationPath '${tmpExtractDir}' -Force"`;
  execSync(psExtract, { stdio: 'inherit' });

  const extractedNodeDir = path.join(
    tmpExtractDir,
    `node-v${nodeVersion}-win-x64`,
  );
  const targetNodeDir = path.join(outputDir, 'node');
  if (fs.existsSync(targetNodeDir)) {
    fs.rmSync(targetNodeDir, { recursive: true, force: true });
  }
  fs.renameSync(extractedNodeDir, targetNodeDir);
  fs.rmSync(tmpExtractDir, { recursive: true, force: true });
  console.log('      完成.\n');

  // Step 6: Assemble directory structure & scripts
  log('[6/7] 组装目录结构及启动脚本...');

  // Create data directory
  const dataDir = path.join(outputDir, 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Create server/.env
  const envContent = `DATABASE_URL="file:../data/wewe-rss.db"
DATABASE_TYPE="sqlite"
PORT=4000
HOST=0.0.0.0
PLATFORM_URL="https://weread.111965.xyz"
AUTH_CODE=""
UPDATE_DELAY_TIME=6
`;
  fs.writeFileSync(path.join(serverTargetDir, '.env'), envContent, 'utf-8');

  // Create 启动WeWe-RSS.bat
  const startBatContent = `@echo off
chcp 65001 >nul 2>&1
title WeWe-RSS 微信公众号 RSS 阅读器
cd /d "%~dp0"
set NO_PROXY=localhost,127.0.0.1,0.0.0.0
set "PATH=%~dp0node;%PATH%"

echo ============================================
echo   WeWe-RSS 微信公众号 RSS 阅读器 - 便携版
echo   启动后请访问: http://localhost:4000/dash
echo   按 Ctrl+C 可停止服务
echo ============================================
echo.

for /f "tokens=5" %%a in ('netstat -ano ^| findstr :4000 ^| findstr LISTENING') do (
    echo 正在关闭占用 4000 端口的进程 PID %%a ...
    taskkill /F /PID %%a >nul 2>&1
)
timeout /t 1 >nul

echo 正在检查并初始化数据库...
pushd "%~dp0server"
"%~dp0node\\node.exe" node_modules\\prisma\\build\\index.js migrate deploy
popd
echo.

start /b cmd /c "timeout /t 3 >nul && start http://localhost:4000/dash"

echo 服务启动中...
pushd "%~dp0server"
"%~dp0node\\node.exe" dist/apps/server/src/main.js
popd

echo.
echo 服务已停止。
pause
`;
  fs.writeFileSync(
    path.join(outputDir, '启动WeWe-RSS.bat'),
    startBatContent,
    'utf-8',
  );

  // Create README.txt
  const readmeContent = `============================================
  WeWe-RSS 微信公众号 RSS 阅读器 - 便携版
============================================

【使用方法】
  1. 双击"启动WeWe-RSS.bat"启动服务
  2. 浏览器会自动打开 http://localhost:4000/dash
  3. 首次使用请先在"账号管理"中扫码添加微信读书账号
  4. 然后在"订阅源"中添加公众号

【配置修改】
  编辑 server\\.env 文件可修改配置:
  - PORT: 服务端口（默认4000）
  - AUTH_CODE: 访问密码（留空则无需密码）
  - UPDATE_DELAY_TIME: 更新间隔（秒，默认6）

【数据存储】
  数据库文件保存在 data\\ 目录下
  备份或迁移时请保留此 data\\ 目录

【停止服务】
  在命令行窗口按 Ctrl+C 即可停止服务
`;
  fs.writeFileSync(path.join(outputDir, 'README.txt'), readmeContent, 'utf-8');

  console.log('      完成.\n');

  // Step 7: Compress into zip
  log('[7/7] 打包为 zip 压缩包...');
  if (fs.existsSync(zipOutputPath)) {
    fs.rmSync(zipOutputPath, { force: true });
  }

  const zipCmd = `tar.exe -a -c -f "${zipOutputPath}" -C "${buildDir}" "WeWe-RSS-Portable"`;
  execSync(zipCmd, { stdio: 'inherit' });
  console.log('      完成.\n');

  console.log('============================================');
  console.log(`  ✅ 构建成功!`);
  console.log(`  解压包目录: ${outputDir}`);
  console.log(`  ZIP压缩包: ${zipOutputPath}`);
  console.log('============================================\n');
}

main();
