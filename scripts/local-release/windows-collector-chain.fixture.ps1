param([int]$ProbePid,[int]$ControllerPid)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
function Snapshot {
  # Only this owned fixture's processes, never whole-host task/profile scanning.
  $filter="ProcessId=$ProbePid OR ParentProcessId=$ProbePid OR ProcessId=$PID OR ParentProcessId=$PID OR ProcessId=$ControllerPid OR ParentProcessId=$ControllerPid"
  $rows=@(Get-CimInstance Win32_Process -Filter $filter -ErrorAction Stop)
  if($rows.Count -gt 64){throw 'OWNED_PROCESS_LIMIT'}
  @($rows | ForEach-Object { [PSCustomObject]@{
    pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;name=[string]$_.Name
    executable=[string]$_.ExecutablePath;commandLine=[string]$_.CommandLine
    startUtc=$(if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}else{$null})
  }})
}
$before=@(Snapshot)
Start-Sleep -Milliseconds 100
$after=@(Snapshot)
[PSCustomObject]@{before=$before;after=$after}|ConvertTo-Json -Depth 7 -Compress
