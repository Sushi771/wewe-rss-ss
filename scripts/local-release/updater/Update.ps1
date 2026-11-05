$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = 'WeWe-RSS 更新'
$form.ClientSize = New-Object System.Drawing.Size(460, 165)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.ControlBox = $false
$label = New-Object System.Windows.Forms.Label
$label.Location = New-Object System.Drawing.Point(24, 24)
$label.Size = New-Object System.Drawing.Size(412, 48)
$label.Text = '正在准备更新…'
$bar = New-Object System.Windows.Forms.ProgressBar
$bar.Location = New-Object System.Drawing.Point(24, 80)
$bar.Size = New-Object System.Drawing.Size(412, 18)
$bar.Style = 'Marquee'
$button = New-Object System.Windows.Forms.Button
$button.Text = '完成'
$button.Location = New-Object System.Drawing.Point(346, 120)
$button.Enabled = $false
$button.Add_Click({ $form.Close() })
$form.Controls.AddRange(@($label, $bar, $button))
$process = New-Object System.Diagnostics.Process
$process.StartInfo.FileName = Join-Path (Split-Path $PSScriptRoot -Parent) 'runtime\node.exe'
$process.StartInfo.Arguments = '"' + (Join-Path $PSScriptRoot 'update-entry.cjs') + '"'
$process.StartInfo.UseShellExecute = $false
$process.StartInfo.CreateNoWindow = $true
$process.StartInfo.RedirectStandardOutput = $true
$process.StartInfo.RedirectStandardError = $true
$process.StartInfo.StandardOutputEncoding = [System.Text.Encoding]::UTF8
$process.StartInfo.StandardErrorEncoding = [System.Text.Encoding]::UTF8
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 150
$state = @{ Line = $null; Errors = $null; Ended = $false; Started = $false }
$timer.Add_Tick({
    try {
        while (!$state.Ended -and $null -ne $state.Line -and $state.Line.IsCompleted) {
            $line = $state.Line.GetAwaiter().GetResult()
            if ($null -eq $line) { $state.Ended = $true; break }
            if ($line.Length -gt 0) { $label.Text = $line }
            $state.Line = $process.StandardOutput.ReadLineAsync()
        }
        if ($state.Ended -and $process.HasExited) {
            $timer.Stop()
            $bar.Style = 'Continuous'
            if ($process.ExitCode -eq 0) { $bar.Value = 100 }
            else {
                $bar.Value = 0
                $button.Text = '关闭'
                if ($process.ExitCode -eq 1) { $label.Text = '更新未完成。请保留更新记录，由维护者处理。' }
            }
            $button.Enabled = $true
            $form.ControlBox = $true
        }
    } catch {
        $timer.Stop()
        $label.Text = '更新仍可能在后台进行。请保留更新记录，由维护者确认。'
        $button.Enabled = $true
        $button.Text = '关闭'
        $form.ControlBox = $true
    }
})
$form.Add_Shown({
    try {
        if (!$process.Start()) { throw 'UPDATE_LAUNCH_FAILED' }
        $state.Started = $true
        $state.Line = $process.StandardOutput.ReadLineAsync()
        $state.Errors = $process.StandardError.ReadToEndAsync()
        $timer.Start()
    } catch {
        $label.Text = '无法启动更新程序。请使用完整安装包。'
        $button.Enabled = $true
        $button.Text = '关闭'
        $form.ControlBox = $true
    }
})
$form.Add_FormClosing({
    param($sender, $eventArgs)
    if ($state.Started -and !$process.HasExited -and !$button.Enabled) { $eventArgs.Cancel = $true }
})
[void]$form.ShowDialog()
$timer.Dispose()
$process.Dispose()
$form.Dispose()
