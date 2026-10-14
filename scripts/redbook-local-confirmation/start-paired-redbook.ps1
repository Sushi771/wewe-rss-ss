param([string]$ArtifactDirectory)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$pairProcess = $null
$pairFailed = $false
function Read-Control($process) {
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    while ([DateTime]::UtcNow -lt $deadline) {
        $read = $process.StandardOutput.ReadLineAsync()
        $remaining = [Math]::Max(1, [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds)
        if (-not $read.Wait($remaining)) { throw 'PAIR_READY_TIMEOUT' }
        $line = $read.Result
        if ($null -eq $line) { throw 'PAIR_PIPE_CLOSED' }
        if ($line.StartsWith('REDBOOK_CONTROL:')) {
            $message = $line.Substring(16) | ConvertFrom-Json
            if ($message.status -eq 'starting') {
                if ($message.phase -in @('NODE_ENTERED','ARTIFACT_CHECK','GATEWAY_LOAD','PORT_CHECK','DATABASE_INIT','BACKEND_LOAD','BACKEND_PROBE','GATEWAY_LISTEN')) {
                    Write-Host ('STARTUP_STAGE: ' + $message.phase)
                }
                continue
            }
            if ($message.status -eq 'startup_rejected') {
                if ($message.phase -in @('NODE_ENTERED','ARTIFACT_CHECK','GATEWAY_LOAD','PORT_CHECK','DATABASE_INIT','BACKEND_LOAD','BACKEND_PROBE','GATEWAY_LISTEN') -and $message.code -in @('MODULE_NOT_FOUND','ENOENT','EACCES','EADDRINUSE','P1001','P1002','P1003','BACKEND_NOT_READY','BOOTSTRAP_ERROR')) {
                    throw ('PAIR_' + $message.phase + '_' + $message.code)
                }
                throw 'PAIR_START_REJECTED'
            }
            return $message
        }
    }
    throw 'PAIR_READY_TIMEOUT'
}
try {
    if ([string]::IsNullOrWhiteSpace($ArtifactDirectory)) { throw 'PAIR_ARTIFACT_REQUIRED' }
    Write-Host 'Redbook 本机确认 · 24小时 · 仅小量诊断'
    Write-Host '不需要设置或记密码。请只确认你自己当前打开的本机页面。'
    $pairStart = New-Object Diagnostics.ProcessStartInfo
    $pairStart.FileName = (Get-Command node -ErrorAction Stop).Source
    $pairStart.Arguments = '"' + (Join-Path $PSScriptRoot 'redbook-pair-launch.cjs') + '" "' + ([IO.Path]::GetFullPath($ArtifactDirectory)) + '"'
    $pairStart.WorkingDirectory = $PSScriptRoot
    $pairStart.UseShellExecute = $false
    $pairStart.CreateNoWindow = $true
    $pairStart.RedirectStandardInput = $true
    $pairStart.RedirectStandardOutput = $true
    $pairStart.RedirectStandardError = $true
    $pairStart.EnvironmentVariables.Clear()
    foreach ($pairKey in @('PATH','SystemRoot','WINDIR','COMSPEC','PATHEXT','USERPROFILE','APPDATA','LOCALAPPDATA','PROGRAMDATA','ProgramFiles','ProgramFiles(x86)','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE','SystemDrive')) {
        $pairValue = [Environment]::GetEnvironmentVariable($pairKey)
        if ($null -ne $pairValue) { $pairStart.EnvironmentVariables[$pairKey] = $pairValue }
    }
    $pairProcess = New-Object Diagnostics.Process
    $pairProcess.StartInfo = $pairStart
    [void]$pairProcess.Start()
    $pairProcess.BeginErrorReadLine()
    $pairReady = Read-Control $pairProcess
    if ($pairReady.status -ne 'ready') { throw 'PAIR_START_REJECTED' }
    Write-Host '本机确认页面已启动，尚未授权任何浏览器或小红书会话。'
    Write-Host '请自行打开：http://127.0.0.1:49163/pair'
    Write-Host '网页点击“请求本机确认”，核对网页身份，再把页面显示的6位核对码输入这里。'
    Write-Host '输入 R 撤销/重新确认，输入 Q 停止。24小时仅是浏览器访问，登录信息内存保留也不超过本次24小时绝对期限，平台提前失效仍停止。'
    while (-not $pairProcess.HasExited) {
        $pairChoice = Read-Host '6位核对码 / R / Q'
        if ($pairChoice -eq 'Q') { break }
        if ($pairChoice -eq 'R') {
            $pairProcess.StandardInput.WriteLine('{"action":"revoke"}')
        } elseif ($pairChoice -match '^\d{6}$') {
            $pairProcess.StandardInput.WriteLine((@{ action='approve'; comparison=$pairChoice }|ConvertTo-Json -Compress))
        } else { Write-Host '请输入当前网页的6位核对码、R 或 Q。'; continue }
        $pairProcess.StandardInput.Flush()
        # A pending-request notification may arrive before the owner confirmation result.
        do { $pairResult = Read-Control $pairProcess } while ($pairResult.status -eq 'confirmation_requested')
        switch ($pairResult.status) {
            'approved_24_hours' { Write-Host '本机确认通过：当前浏览器可小量诊断24小时，正式批量归档仍关闭。' }
            'revoked' { Write-Host '已撤销访问和小红书会话；可以在网页重新请求确认。' }
            'cleanup_failed' { Write-Host '浏览器访问已撤销，会话清理未确认；请按 R 重试或 Q 停止实例。清理前不会重新授权。' }
            default { Write-Host '确认未通过。核对码可能过期或不匹配；未发放访问凭证。' }
        }
    }
} catch {
    $pairFailed = $true
    Write-Host '本机确认入口未就绪或已断开。请检查49163/49164是否被占用、已验收构建是否存在。不会停止其他服务。'
    $pairReason = $_.Exception.Message
    if ($pairReason -match '^PAIR_[A-Z0-9_]+$') { Write-Host ('错误代码：' + $pairReason) }
} finally {
    if ($null -ne $pairProcess) {
        if (-not $pairProcess.HasExited) {
            try { $pairProcess.StandardInput.WriteLine('{"action":"stop"}'); $pairProcess.StandardInput.Close() } catch { }
            if (-not $pairProcess.WaitForExit(5000)) { $pairProcess.Kill(); $pairProcess.WaitForExit() }
        }
        $pairProcess.Dispose()
    }
}
if ($pairFailed) { exit 1 }
