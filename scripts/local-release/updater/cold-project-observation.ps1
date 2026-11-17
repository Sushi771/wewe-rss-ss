[CmdletBinding()]
param([Parameter(Mandatory)][string]$ProjectRoot,[Parameter(Mandatory)][string]$Database,
      [Parameter(Mandatory)][int]$OwnerPid,[string]$TrackedRoots='')
$ErrorActionPreference='Stop'
# Read-only bounded census, not a stop receipt. Include non-listening project
# processes and descendants, even when the original tracked root has exited.
try {
  if (-not [IO.Path]::IsPathRooted($ProjectRoot) -or -not [IO.Path]::IsPathRooted($Database) -or $OwnerPid -le 0) { throw 'COLD_OBSERVATION_INPUT_INVALID' }
  $rows=@(Get-CimInstance Win32_Process -ErrorAction Stop)
  if ($rows.Count -gt 4096) { throw 'COLD_OBSERVATION_LIMIT' }
  $roots=[Collections.Generic.HashSet[int]]::new()
  foreach($item in $TrackedRoots.Split(',',[StringSplitOptions]::RemoveEmptyEntries)) {
    $number=0;if(-not [int]::TryParse($item,[ref]$number) -or $number -le 0){throw 'COLD_OBSERVATION_INPUT_INVALID'}
    [void]$roots.Add($number)
  }
  $critical=@('node.exe','python.exe','python3.exe','pythonw.exe','sqlite3.exe','schema-engine-windows.exe')
  foreach($row in $rows) {
    if($row.ProcessId -in @($PID,$OwnerPid)){continue}
    if($critical -contains ([string]$row.Name).ToLowerInvariant() -and
       (-not $row.ExecutablePath -or -not $row.CommandLine)){throw 'COLD_PROCESS_METADATA_INCOMPLETE'}
    if(([string]$row.ExecutablePath).StartsWith($ProjectRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or
       ([string]$row.CommandLine).IndexOf($ProjectRoot,[StringComparison]::OrdinalIgnoreCase) -ge 0 -or
       ([string]$row.CommandLine).IndexOf($Database,[StringComparison]::OrdinalIgnoreCase) -ge 0){[void]$roots.Add([int]$row.ProcessId)}
  }
  do {$changed=$false;foreach($row in $rows){if($roots.Contains([int]$row.ParentProcessId) -and -not $roots.Contains([int]$row.ProcessId)){
    [void]$roots.Add([int]$row.ProcessId);$changed=$true
  }}} while($changed)
  $active=@(foreach($row in $rows){
    if(-not $roots.Contains([int]$row.ProcessId) -or $row.ProcessId -in @($PID,$OwnerPid)){continue}
    if(-not $row.ExecutablePath -or -not $row.CommandLine){throw 'COLD_PROCESS_METADATA_INCOMPLETE'}
    $process=[Diagnostics.Process]::GetProcessById([int]$row.ProcessId)
    try {
      $null=$process.Handle
      $birth=$process.StartTime.ToUniversalTime()
      $created=([datetime]$row.CreationDate).ToUniversalTime()
      if([Math]::Abs(($created-$birth).TotalSeconds) -gt 1 -or $process.HasExited){throw 'COLD_PROCESS_IDENTITY_CHANGED'}
      @{pid=[int]$row.ProcessId;parentPid=[int]$row.ParentProcessId;startUtc=$birth.ToString('o');executable=[string]$row.ExecutablePath;commandLine=[string]$row.CommandLine}
    } finally {$process.Dispose()}
  })
  if($active.Count -gt 64){throw 'COLD_OBSERVATION_LIMIT'}
  @{complete=$true;kind='cold-project-census-v1';active=$active;observerPid=$PID;ownerPid=$OwnerPid}|ConvertTo-Json -Depth 8 -Compress
} catch {
  $code=[string]$_.Exception.Message
  if($code -notmatch '^COLD_[A-Z_]+$'){$code='COLD_OBSERVATION_FAILED'}
  [Console]::Error.WriteLine($code);exit 1
}
