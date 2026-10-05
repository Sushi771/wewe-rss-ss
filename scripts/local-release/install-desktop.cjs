// Run from the stable checkout after integration. No tasks/security settings.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { run } = require('./lib.cjs');
function installDesktop({
  root = path.resolve(__dirname, '../..'),
  testDesktop,
} = {}) {
  if (process.platform !== 'win32') throw new Error('Windows only');
  root = fs.realpathSync(root);
  const inTemporary = path.relative(os.tmpdir(), root);
  if (
    !testDesktop &&
    !inTemporary.startsWith('..') &&
    !path.isAbsolute(inTemporary)
  )
    throw new Error(
      'Install from the stable checkout, not a temporary worktree',
    );
  const entry = path.join(root, 'scripts/local-release/launch-desktop.vbs');
  const icon = path.join(root, 'assets/wewe-rss.ico');
  for (const file of [entry, icon])
    if (!fs.statSync(file).isFile()) throw new Error('Missing launcher asset');
  const data = Buffer.from(
    JSON.stringify({ root, entry, icon, testDesktop }),
  ).toString('base64');
  const script = `
    $ErrorActionPreference = 'Stop'
    $p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')) | ConvertFrom-Json
    $desktop = [Environment]::GetFolderPath('DesktopDirectory')
    if ($p.testDesktop) { $desktop = (Resolve-Path -LiteralPath $p.testDesktop).Path }
    if (-not $desktop) { throw 'Windows desktop location is missing' }
    $target = Join-Path $desktop 'WeWe-RSS.lnk'
    $hostPath = Join-Path $env:SystemRoot 'System32/wscript.exe'
    $arguments = '"' + $p.entry + '"'
    $description = 'WeWe-RSS managed desktop launcher: ' + $p.root
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($target)
    if (Test-Path -LiteralPath $target) {
      if ($shortcut.TargetPath -ine $hostPath -or $shortcut.Arguments -cne $arguments -or $shortcut.Description -cne $description -or $shortcut.WorkingDirectory -ine $p.root) {
        throw 'An unrelated WeWe-RSS shortcut exists; nothing was replaced'
      }
    }
    $shortcut.TargetPath = $hostPath
    $shortcut.Arguments = $arguments
    $shortcut.WorkingDirectory = $p.root
    $shortcut.IconLocation = $p.icon + ',0'
    $shortcut.Description = $description
    $shortcut.WindowStyle = 7
    $shortcut.Save()
    $check = $shell.CreateShortcut($target)
    if ($check.TargetPath -ine $hostPath -or $check.Arguments -cne $arguments -or $check.IconLocation -ine ($p.icon + ',0')) { throw 'Shortcut verification failed' }
    @{ shortcut = $target; root = $p.root; verified = $true } | ConvertTo-Json -Compress
  `;
  const powershell = path.join(
    process.env.SystemRoot,
    'System32/WindowsPowerShell/v1.0/powershell.exe',
  );
  return JSON.parse(
    run(powershell, [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ]),
  );
}
if (require.main === module) {
  try {
    console.log(JSON.stringify(installDesktop()));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { installDesktop };
