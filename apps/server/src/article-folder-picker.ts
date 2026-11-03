import { execFile, ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { ArticleDownloadError } from './article-download';

/** User-triggered Windows dialog. Never accepts a destination path from browser JSON. */
export async function pickArticleDirectory(
  initial: string,
  options: {
    platform?: 'wechat' | 'xiaohongshu';
    signal?: AbortSignal;
    count?: number;
  } = {},
): Promise<string | null> {
  if (process.platform !== 'win32')
    throw new ArticleDownloadError(
      '选择保存路径需要本机 Windows 桌面服务。',
      409,
    );
  if (options.signal?.aborted)
    throw new ArticleDownloadError('目录选择已取消。', 422, {
      code: 'DIRECTORY_PICKER_CANCELLED',
    });
  const title =
    options.platform === 'xiaohongshu'
      ? '选择小红书内容保存文件夹'
      : '选择公众号文章保存文件夹';
  const scopedTitle = options.count
    ? `${title}（已选 ${options.count} 篇，仅此范围）`
    : title;
  const encodedTitle = Buffer.from(scopedTitle, 'utf8').toString('base64');
  const encodedInitial = Buffer.from(initial, 'utf8').toString('base64');
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
$dialog = [System.Windows.Forms.FolderBrowserDialog]::new()
$title = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedTitle}'))
$dialog.Description = $title
$dialog.ShowNewFolderButton = $true
$initial = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedInitial}'))
if (Test-Path -LiteralPath $initial -PathType Container) { $dialog.SelectedPath = $initial }
$owner = [System.Windows.Forms.Form]::new()
try {
  $owner.Text = $title
  $owner.TopMost = $true
  $owner.ShowInTaskbar = $false
  $owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
  $owner.Size = [System.Drawing.Size]::new(1, 1)
  $owner.Opacity = 0
  $owner.Show()
  $owner.Activate()
  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Write([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($dialog.SelectedPath)))
  }
} finally {
  try { $dialog.Dispose() } finally { $owner.Dispose() }
}
`;
  return new Promise((resolve, reject) => {
    let child: ChildProcess | undefined;
    let cancelled = false;
    const abort = () => {
      cancelled = true;
      try {
        child?.kill();
      } catch {
        // Keep the lock while termination is unproved. An execFile error
        // callback is checked against the child lifecycle below.
      }
    };
    child = execFile(
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
        const finish = () => {
          options.signal?.removeEventListener('abort', abort);
          if (cancelled || options.signal?.aborted)
            return reject(
              new ArticleDownloadError('目录选择已取消。', 422, {
                code: 'DIRECTORY_PICKER_CANCELLED',
              }),
            );
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
        };
        // execFile may call back on a child error before the process exits.
        // A live picker must keep the controller lock until this child's close.
        if (
          error &&
          child?.pid &&
          child.exitCode === null &&
          child.signalCode === null
        ) {
          child.once('close', finish);
          return;
        }
        finish();
      },
    );
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}
