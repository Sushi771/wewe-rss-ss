param([Parameter(Mandatory=$true)][string]$StateFile, [string]$ReceiptFile)
$ErrorActionPreference = 'Stop'
# ReceiptFile is an optional handshake path supplied by the launcher.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WeWeStartupWindow {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
'@
$title = 'WeWe-RSS 启动'
$uiLog = Join-Path (Split-Path -Parent $StateFile) 'desktop-progress-ui.jsonl'
function Write-UiEvent($kind, $visible, $focused) {
  @{ at=[DateTime]::UtcNow.ToString('o'); event=$kind; pid=$PID; visible=$visible; focused=$focused } | ConvertTo-Json -Compress | Add-Content -LiteralPath $uiLog -Encoding UTF8
}
function Write-Receipt($kind) {
  if ($ReceiptFile) { @{ event=$kind; pid=$PID } | ConvertTo-Json -Compress | Set-Content -LiteralPath $ReceiptFile -Encoding UTF8 }
}
function Read-StartupState {
  # The writer atomically renames its next state over this path. Windows readers
  # share deletion and dispose promptly. The writer also bounds retries for
  # Windows versions that reject replacing an open destination regardless.
  $sharing = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
  $stream = [IO.File]::Open($StateFile, [IO.FileMode]::Open, [IO.FileAccess]::Read, $sharing)
  $reader = $null
  try {
    $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8)
    $text = $reader.ReadToEnd()
  } finally {
    if ($reader) { $reader.Dispose() } else { $stream.Dispose() }
  }
  # Parse after closing the OS handle. ConvertFrom-Json may load/JIT on its
  # first invocation; that work must not hold the destination during rename.
  return ($text | ConvertFrom-Json)
}
$sha = [Security.Cryptography.SHA256]::Create()
$key = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($StateFile.ToLowerInvariant()))).Replace('-', '')
$mutex = New-Object Threading.Mutex($false, ('Local\WeWeStartup-' + $key))
$owned = $false
try {
  try { $owned = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $owned = $true }
  if (-not $owned) {
    $handle = [WeWeStartupWindow]::FindWindow([NullString]::Value, $title)
    $deadline = [DateTime]::UtcNow.AddSeconds(3)
    while ($handle -eq [IntPtr]::Zero -and [DateTime]::UtcNow -lt $deadline) {
      Start-Sleep -Milliseconds 100
      $handle = [WeWeStartupWindow]::FindWindow([NullString]::Value, $title)
    }
    if ($handle -ne [IntPtr]::Zero) {
      [void][WeWeStartupWindow]::ShowWindow($handle, 9)
      $focused = [WeWeStartupWindow]::SetForegroundWindow($handle)
      Write-UiEvent 'focus-existing' $true $focused
      Write-Receipt 'focus-existing'
    } else {
      Write-Receipt 'existing-window'
    }
    exit 0
  }
  $form = New-Object Windows.Forms.Form
  $form.Text = $title
  $form.Size = New-Object Drawing.Size(570, 260)
  $form.StartPosition = 'CenterScreen'
  $form.FormBorderStyle = 'FixedDialog'
  $form.MaximizeBox = $false
  $form.Font = New-Object Drawing.Font('Microsoft YaHei UI', 10)
  $form.Add_Shown({ [void][WeWeStartupWindow]::ShowWindow($form.Handle, 1); $focused = [WeWeStartupWindow]::SetForegroundWindow($form.Handle); Write-UiEvent 'shown' $form.Visible $focused; Write-Receipt 'shown' })
  $label = New-Object Windows.Forms.Label
  $label.Location = New-Object Drawing.Point(22, 22)
  $label.Size = New-Object Drawing.Size(510, 85)
  $label.Text = '正在准备启动…'
  $form.Controls.Add($label)
  $hint = New-Object Windows.Forms.Label
  $hint.Location = New-Object Drawing.Point(22, 110)
  $hint.Size = New-Object Drawing.Size(510, 26)
  $hint.Text = '关闭此窗口不会停止启动。连续点击会复用当前任务。'
  $form.Controls.Add($hint)
  $backend = New-Object Windows.Forms.Button
  $backend.Text = '打开Wechat2RSS后台'
  $backend.Location = New-Object Drawing.Point(22, 153)
  $backend.Size = New-Object Drawing.Size(190, 35)
  $backend.Enabled = $false
  $backend.Add_Click({ Start-Process 'http://127.0.0.1:18080/#/' })
  $form.Controls.Add($backend)
  $logs = New-Object Windows.Forms.Button
  $logs.Text = '查看日志'
  $logs.Location = New-Object Drawing.Point(224, 153)
  $logs.Size = New-Object Drawing.Size(120, 35)
  $logs.Add_Click({ Start-Process -FilePath explorer.exe -ArgumentList ('"' + (Split-Path -Parent $StateFile) + '"') })
  $form.Controls.Add($logs)
  $retry = New-Object Windows.Forms.Button
  $retry.Text = '重新启动'
  $retry.Location = New-Object Drawing.Point(356, 153)
  $retry.Size = New-Object Drawing.Size(120, 35)
  $retry.Enabled = $false
  $launcher = Join-Path $PSScriptRoot 'launch-desktop.vbs'
  $retry.Add_Click({
    Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\wscript.exe') -ArgumentList ('"' + $launcher + '"') -WindowStyle Hidden
    $form.Close()
  })
  $form.Controls.Add($retry)
  $script:readyAt = $null
  $timer = New-Object Windows.Forms.Timer
  $timer.Interval = 250
  $timer.Add_Tick({
    try {
      $state = Read-StartupState
      $label.Text = [string]$state.message
      $backend.Enabled = [bool]$state.backendReady
      if ($state.status -in @('ready', 'available')) {
        if ($null -eq $script:readyAt) { $script:readyAt = [DateTime]::UtcNow }
        # UI dismissal happens only after real readiness, never as a service delay.
        if (([DateTime]::UtcNow - $script:readyAt).TotalSeconds -ge 2) { $form.Close() }
      } elseif ($state.status -eq 'failed') {
        $retry.Enabled = $true
        $hint.Text = '启动未完成。请按提示处理后重试，日志保留在本机。'
      } elseif (-not (Get-Process -Id ([int]$state.parentPid) -ErrorAction SilentlyContinue)) {
        $label.Text = '启动进程已退出。请查看日志后重试。'
        $retry.Enabled = $true
      }
    } catch { $label.Text = '正在等待启动状态… 若持续无变化，请查看日志。' }
  })
  $timer.Start()
  [void]$form.ShowDialog()
  $timer.Stop()
  $timer.Dispose()
  $form.Dispose()
} finally {
  if ($owned) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
  $sha.Dispose()
}
