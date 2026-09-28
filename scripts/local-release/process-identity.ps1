# Windows 进程身份核验。Stop 操作持有 Process 对象句柄，避免按 PID 二次查找后误杀复用 PID。
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Snapshot', 'Stop', 'Port')][string]$Action,
    [int]$TargetPid,
    [Parameter(Mandatory)][ValidateRange(1, 65535)][int]$Port,
    [string]$ExpectedStartUtc,
    [string]$ExpectedExecutable,
    [string]$ExpectedCommandLine
)

$ErrorActionPreference = 'Stop'
if ($Action -eq 'Port') {
    $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object LocalAddress, OwningProcess)
    ConvertTo-Json -InputObject $listeners -Compress -Depth 3
    return
}
if ($TargetPid -le 0) { throw '无效的目标 PID' }
$process = [System.Diagnostics.Process]::GetProcessById($TargetPid)
try {
    # 先取得句柄，再读取 CIM 和监听端口；后续 Kill 使用同一对象。
    $null = $process.Handle
    $startUtc = $process.StartTime.ToUniversalTime().ToString('o')
    $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$TargetPid"
    if ($null -eq $cim) { throw '目标进程的 CIM 记录不存在' }
    if ([Math]::Abs(($cim.CreationDate.ToUniversalTime() - $process.StartTime.ToUniversalTime()).TotalSeconds) -gt 1) {
        throw '进程句柄与 CIM 启动时间不一致'
    }
    $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen)
    if ($listeners.Count -eq 0 -or @($listeners | Where-Object { $_.OwningProcess -ne $TargetPid }).Count -ne 0) {
        throw '监听端口不存在或由其他进程占有'
    }
    $executable = [string]$cim.ExecutablePath
    $commandLine = [string]$cim.CommandLine
    if (-not $executable -or -not $commandLine) { throw '无法读取进程程序路径或命令行' }
    $identity = [ordered]@{
        pid = $TargetPid
        startUtc = $startUtc
        executable = $executable
        commandLine = $commandLine
        port = $Port
        localAddresses = @($listeners | ForEach-Object { $_.LocalAddress } | Sort-Object -Unique)
    }
    if ($Action -eq 'Stop') {
        if (-not $ExpectedStartUtc -or -not $ExpectedExecutable -or -not $ExpectedCommandLine) {
            throw '停止进程必须提供完整的预期身份'
        }
        if ($startUtc -cne $ExpectedStartUtc -or
            -not [string]::Equals($executable, $ExpectedExecutable, [StringComparison]::OrdinalIgnoreCase) -or
            -not [string]::Equals($commandLine, $ExpectedCommandLine, [StringComparison]::Ordinal)) {
            throw '进程身份已变化；拒绝停止'
        }
        if ($process.HasExited) { throw '进程已退出；拒绝停止' }
        $process.Kill()
        if (-not $process.WaitForExit(15000)) { throw '已发送停止请求，但进程未在 15 秒内退出' }
        $identity.stopped = $true
    }
    $identity | ConvertTo-Json -Compress -Depth 4
} finally {
    $process.Dispose()
}
