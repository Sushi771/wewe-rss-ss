# Register only this user's managed logon task. Existing unrelated tasks are never replaced.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Release
)

$ErrorActionPreference = 'Stop'
Import-Module ScheduledTasks -ErrorAction Stop
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$entry = Join-Path $root 'scripts/local-release/logon-start.cjs'
$node = 'C:\Program Files\nodejs\node.exe'
$taskName = 'WeWe-RSS-Logon-Start'
$description = "WeWe-RSS managed logon start: $root"
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$user = $identity.Name
$userSid = $identity.User.Value
function Test-CurrentUser([string]$account) {
    if (-not $account) { return $false }
    try {
        return ([System.Security.Principal.NTAccount]::new($account)).Translate(
            [System.Security.Principal.SecurityIdentifier]).Value -eq $userSid
    } catch { return $false }
}
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'Fixed Node executable is missing' }
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw 'Logon entry point is missing' }

# Activation requires a live process from this exact verified release; it cannot switch a running service.
& $node $entry activate --release $Release
if ($LASTEXITCODE -ne 0) { throw 'Live release identity check failed; task not registered' }

$argument = '"' + $entry + '" start'
$existing = Get-ScheduledTask -TaskPath '\' -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    $owned = $existing.Description -eq $description -and
        (Test-CurrentUser $existing.Principal.UserId) -and
        $existing.Actions.Count -eq 1 -and
        $existing.Actions[0].Execute -eq $node -and
        $existing.Actions[0].Arguments -eq $argument -and
        $existing.Actions[0].WorkingDirectory -eq $root
    if (-not $owned) { throw 'A task with this name exists but does not match this checkout' }
}

$action = New-ScheduledTaskAction -Execute $node -Argument $argument -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskPath '\' -TaskName $taskName -Description $description -Action $action `
    -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

$registered = Get-ScheduledTask -TaskPath '\' -TaskName $taskName -ErrorAction Stop
if (-not (Test-CurrentUser $registered.Principal.UserId) -or
    $registered.Principal.LogonType -ne 'Interactive' -or
    $registered.Settings.MultipleInstances -ne 'IgnoreNew' -or
    $registered.Actions[0].Execute -ne $node -or
    $registered.Actions[0].Arguments -ne $argument -or
    $registered.Triggers.Count -ne 1 -or
    -not (Test-CurrentUser $registered.Triggers[0].UserId)) {
    throw 'Registered task properties differ from the managed definition'
}
$registered | Select-Object TaskName, State,
    @{Name='UserId';Expression={$_.Principal.UserId}},
    @{Name='LogonType';Expression={$_.Principal.LogonType}},
    @{Name='MultipleInstances';Expression={$_.Settings.MultipleInstances}}
