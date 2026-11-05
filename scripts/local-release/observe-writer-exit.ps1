param([Parameter(Mandatory=$true)][int]$OwnerPid,[Parameter(Mandatory=$true)][string]$OwnerStartUtc)
$ErrorActionPreference='Stop'
if($OwnerPid -le 0){throw 'EXIT_PID_INVALID'}
$boot=(Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime()
$at=[DateTime]::UtcNow
$rows=@(Get-CimInstance Win32_Process -Filter "ProcessId=$OwnerPid" -ErrorAction Stop)
if($rows.Count -gt 1){throw 'EXIT_OWNER_AMBIGUOUS'}
$owner=$null
if($rows.Count -eq 1){
 $p=[Diagnostics.Process]::GetProcessById($OwnerPid)
 try{$null=$p.Handle;$start=$p.StartTime.ToUniversalTime();$wmi=$rows[0].CreationDate.ToUniversalTime();if([Math]::Abs(($wmi-$start).TotalSeconds) -gt 1){throw 'EXIT_BIRTH_CHANGED'};$owner=@{pid=$OwnerPid;startUtc=$start.ToString('o')}}finally{$p.Dispose()}
}
$remaining=New-Object 'System.Collections.Generic.List[int]'
# Prior-boot descendants cannot survive a real OS restart. A reused live PID is unrelated.
if($boot -le [DateTime]::Parse($OwnerStartUtc).ToUniversalTime() -and $null -eq $owner){
 $queue=New-Object 'System.Collections.Generic.Queue[int]';$queue.Enqueue($OwnerPid);$seen=@{}
 while($queue.Count -gt 0){$id=$queue.Dequeue();if($seen.ContainsKey($id)){continue};$seen[$id]=$true;if($seen.Count -gt 64){throw 'EXIT_TREE_LIMIT'}
  foreach($row in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$id" -ErrorAction Stop)){ $child=[int]$row.ProcessId;$remaining.Add($child);$queue.Enqueue($child) }
 }
}
@{complete=$true;bootUtc=$boot.ToString('o');atUtc=$at.ToString('o');owner=$owner;remaining=@($remaining.ToArray())}|ConvertTo-Json -Compress -Depth 4
