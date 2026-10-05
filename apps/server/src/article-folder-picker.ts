import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { ArticleDownloadError } from './article-download';

/** User-triggered Windows dialog. Never accepts a destination path from browser JSON. */
export async function pickArticleDirectory(
  initial: string,
): Promise<string | null> {
  if (process.platform !== 'win32')
    throw new ArticleDownloadError(
      '选择保存路径需要本机 Windows 桌面服务。',
      409,
    );
  const encodedInitial = Buffer.from(initial, 'utf8').toString('base64');
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
$dialog = [System.Windows.Forms.FolderBrowserDialog]::new()
$dialog.Description = '选择公众号文章保存文件夹'
$dialog.ShowNewFolderButton = $true
$initial = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedInitial}'))
if (Test-Path -LiteralPath $initial -PathType Container) { $dialog.SelectedPath = $initial }
try {
  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Write([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($dialog.SelectedPath)))
  }
} finally { $dialog.Dispose() }
`;
  return new Promise((resolve, reject) => {
    execFile(
      path.join(
        process.env.SystemRoot || 'C:\\Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      ),
      [
        '-NoProfile',
        '-STA',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      {
        windowsHide: true,
        timeout: 300_000,
        maxBuffer: 8192,
        encoding: 'utf8',
      },
      (error, stdout) => {
        if (error)
          return reject(
            new ArticleDownloadError(
              '目录选择未完成，请在本机桌面重试。',
              422,
              { code: 'DIRECTORY_PICKER_FAILED' },
            ),
          );
        const encoded = stdout.trim();
        if (!encoded) return resolve(null);
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
          return reject(new ArticleDownloadError('目录选择结果无效。', 422));
        resolve(Buffer.from(encoded, 'base64').toString('utf8'));
      },
    );
  });
}
