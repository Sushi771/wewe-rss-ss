# Windows 进程身份核验。Stop 操作持有 Process 对象句柄，避免按 PID 二次查找后误杀复用 PID。
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Snapshot', 'Stop', 'Port', 'Discover', 'AuxiliarySnapshot', 'WaitAuxiliary', 'ControllerExited')][string]$Action,
    [int]$TargetPid,
    [Parameter(Mandatory)][ValidateRange(1, 65535)][int]$Port,
    [string]$ExpectedStartUtc,
    [string]$ExpectedExecutable,
    [string]$ExpectedCommandLine,
    [string]$ExpectedAuxiliaryJson
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'tcp-listeners.ps1')
if ($Action -eq 'ControllerExited') {
    # Single approved controller PID only. Any present/reused PID or query
    # uncertainty refuses; this branch never kills or enumerates other processes.
    if ($TargetPid -le 0) { throw 'CONTROLLER_PID_REQUIRED' }
    foreach ($attempt in 1..2) {
        $controller = $null
        try { $controller = [System.Diagnostics.Process]::GetProcessById($TargetPid) }
        catch {
            if (-not ($_.Exception.InnerException -is [System.ArgumentException])) { throw }
        }
        if ($null -ne $controller) {
            $controller.Dispose()
            throw 'CONTROLLER_STILL_PRESENT'
        }
        if ($null -ne (Get-CimInstance Win32_Process -Filter "ProcessId=$TargetPid")) { throw 'CONTROLLER_STILL_PRESENT' }
    }
    [ordered]@{format=1;pid=$TargetPid;exited=$true;observation='current-pid-absence-only'} | ConvertTo-Json -Compress
    return
}
if ($Action -in @('AuxiliarySnapshot', 'WaitAuxiliary')) {
    if (-not $ExpectedAuxiliaryJson -or $ExpectedAuxiliaryJson.Length -gt 65536) { throw 'EXACT_AUXILIARY_BINDING_REQUIRED' }
    $decodedPins = ConvertFrom-Json -InputObject $ExpectedAuxiliaryJson
    $pins = @($decodedPins)
    if ($pins.Count -gt 2 -or @($pins | Select-Object -ExpandProperty pid -Unique).Count -ne $pins.Count) { throw 'EXACT_AUXILIARY_LIMIT' }
    $handles = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
    try {
        foreach ($pin in $pins) {
            if ([int]$pin.pid -le 0 -or [int]$pin.parentPid -le 0 -or -not $pin.startUtc -or -not $pin.executable -or -not $pin.commandLine) { throw 'EXACT_AUXILIARY_BINDING_REQUIRED' }
            try { $child = [System.Diagnostics.Process]::GetProcessById([int]$pin.pid) }
            catch {
                if ($_.Exception.InnerException -is [System.ArgumentException]) { continue }
                throw
            }
            $handles.Add($child)
            $null = $child.Handle
            if ($child.HasExited) { continue }
            $childStart = $child.StartTime.ToUniversalTime().ToString('o')
            $childCim = Get-CimInstance Win32_Process -Filter "ProcessId=$($pin.pid)"
            if ($null -eq $childCim) {
                if ($child.HasExited) { continue }
                throw 'EXACT_AUXILIARY_QUERY_INCOMPLETE'
            }
            if ($childStart -cne [string]$pin.startUtc -or
                [int]$childCim.ParentProcessId -ne [int]$pin.parentPid -or
                -not [string]::Equals([string]$childCim.ExecutablePath, [string]$pin.executable, [StringComparison]::OrdinalIgnoreCase) -or
                -not [string]::Equals([string]$childCim.CommandLine, [string]$pin.commandLine, [StringComparison]::Ordinal) -or
                [Math]::Abs(($childCim.CreationDate.ToUniversalTime() - $child.StartTime.ToUniversalTime()).TotalSeconds) -gt 1) {
                throw 'EXACT_AUXILIARY_IDENTITY_CHANGED'
            }
        }
        if ($Action -eq 'WaitAuxiliary') {
            $deadline = [DateTime]::UtcNow.AddSeconds(60)
            foreach ($child in $handles) {
                if (-not $child.HasExited) {
                    $remaining = [Math]::Max(0, [Math]::Min(60000, [Math]::Ceiling(($deadline - [DateTime]::UtcNow).TotalMilliseconds)))
                    if (-not $child.WaitForExit([int]$remaining)) { throw 'EXACT_AUXILIARY_EXIT_TIMEOUT' }
                }
            }
        }
        $remainingPids = @($handles | Where-Object { -not $_.HasExited } | ForEach-Object { $_.Id })
        [ordered]@{format=1;verifiedCount=$pins.Count;exited=($remainingPids.Count -eq 0);remainingPids=$remainingPids} | ConvertTo-Json -Compress -Depth 3
    } finally {
        foreach ($child in $handles) { $child.Dispose() }
    }
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
