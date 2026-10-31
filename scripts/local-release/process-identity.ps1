# Windows 进程身份核验。Stop 操作持有 Process 对象句柄，避免按 PID 二次查找后误杀复用 PID。
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Snapshot', 'Stop', 'Port', 'Discover', 'OwnedSnapshot', 'OwnedStop', 'Tree')][string]$Action,
    [int]$TargetPid,
    [Parameter(Mandatory)][ValidateRange(1, 65535)][int]$Port,
    [string]$ExpectedStartUtc,
    [string]$ExpectedExecutable,
    [string]$ExpectedCommandLine
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'tcp-listeners.ps1')
if ($Action -eq 'Tree') {
    if ($TargetPid -le 0) { throw 'Invalid project root PID' }
    $pending=[Collections.Generic.Queue[int]]::new();$pending.Enqueue($TargetPid)
    $visited=[Collections.Generic.HashSet[int]]::new();$records=@{};$watch=[Diagnostics.Stopwatch]::StartNew()
    while($pending.Count -gt 0) {
        $parent=$pending.Dequeue();if(-not $visited.Add($parent)){continue}
        if($visited.Count -gt 64 -or $watch.ElapsedMilliseconds -gt 15000){throw 'Project process observation limit'}
        $rows=@(Get-CimInstance Win32_Process -Filter "ProcessId=$parent OR ParentProcessId=$parent" -ErrorAction Stop)
        foreach($row in $rows) {
            $childId=[int]$row.ProcessId
            if(-not $row.ExecutablePath -or -not $row.CommandLine){throw 'Project process metadata unavailable'}
            $owned=[Diagnostics.Process]::GetProcessById($childId)
            try{$null=$owned.Handle;$records[$childId]=@{pid=$childId;parentPid=[int]$row.ParentProcessId;startUtc=$owned.StartTime.ToUniversalTime().ToString('o');executable=[string]$row.ExecutablePath;commandLine=[string]$row.CommandLine}}finally{$owned.Dispose()}
            if($childId -ne $parent){$pending.Enqueue($childId)}
        }
    }
    @{complete=$true;active=@($records.Values);portOwners=@(Get-LocalTcpListener -Port $Port)}|ConvertTo-Json -Compress -Depth 5
    return
}
if ($Action -eq 'Port') {
    $listeners = @(Get-LocalTcpListener -Port $Port |
        Select-Object LocalAddress, OwningProcess)
    ConvertTo-Json -InputObject $listeners -Compress -Depth 3
    return
}
if ($Action -eq 'Discover') {
    $owners = @(Get-LocalTcpListener -Port $Port)
    if ($owners.Count -eq 0) { 'null'; return }
    $pids = @($owners | Select-Object -ExpandProperty OwningProcess -Unique)
    if ($pids.Count -ne 1) { throw 'Port has multiple listener owners' }
    $TargetPid = $pids[0]
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
    $listeners = @(Get-LocalTcpListener -Port $Port)
    $ownedAction=$Action -eq 'OwnedSnapshot' -or $Action -eq 'OwnedStop'
    if (-not $ownedAction -and ($listeners.Count -eq 0 -or @($listeners | Where-Object { $_.OwningProcess -ne $TargetPid }).Count -ne 0)) {
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
    if ($ownedAction -and (-not $ExpectedExecutable -or -not $ExpectedCommandLine -or -not [string]::Equals($executable,$ExpectedExecutable,[StringComparison]::OrdinalIgnoreCase) -or $commandLine -cne $ExpectedCommandLine)) { throw 'Owned process launch identity changed' }
    if ($Action -eq 'Stop' -or $Action -eq 'OwnedStop') {
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
