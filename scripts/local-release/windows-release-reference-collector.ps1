param([Parameter(Mandatory=$true)][string]$PolicyFile)
# Read-only host facts. No scripts/shortcuts/tasks are launched or modified.
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
Add-Type -LiteralPath (Join-Path $PSScriptRoot 'windows-reference-directory-identity.cs') -ErrorAction Stop
$errors=[System.Collections.Generic.List[string]]::new()
$coverage=[System.Collections.Generic.List[object]]::new()
$shortcuts=[System.Collections.Generic.List[object]]::new()
$directorySnapshots=[System.Collections.Generic.List[object]]::new()
$deadline=[DateTime]::UtcNow.AddSeconds(16)
function Budget {
  if ([DateTime]::UtcNow -gt $deadline) { throw 'REFERENCE_NATIVE_DEADLINE' }
}
function Expand-ReferenceText([string]$value) {
  $expanded=[Environment]::ExpandEnvironmentVariables($value)
  if ($expanded -match '%[A-Za-z_][A-Za-z0-9_]*%') { throw 'REFERENCE_NATIVE_ENVIRONMENT_UNRESOLVED' }
  $expanded
}
function Directory-Proof([string]$value) {
  $proof=[WeWeReferenceDirectoryIdentity]::Read($value)
  if ($null -eq $proof) { return $null }
  [PSCustomObject]@{path=$proof.path;identity=@($proof.dev,$proof.ino,$proof.birthtimeNs)}
}
function Processes {
  $items=@(Get-CimInstance Win32_Process -ErrorAction Stop)
  if ($items.Count -gt 8192) { throw 'REFERENCE_NATIVE_PROCESS_LIMIT' }
  @($items | ForEach-Object {
    Budget
    $startUtc=$(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null })
    if ($projectOnly) {
      $related=([int]$_.ProcessId -eq [int]$policy.preservingUpdate.active.oldProcess.pid)
      foreach ($text in @([string]$_.ExecutablePath,[string]$_.CommandLine)) {
        foreach ($needle in $projectNeedles) {
          if ($needle -and $text.Replace('/','\').IndexOf($needle.Replace('/','\'),[StringComparison]::OrdinalIgnoreCase) -ge 0) { $related=$true }
        }
      }
      if ($related) {
        # Same clock as process-identity.ps1 Snapshot; CIM truncates sub-microsecond
        # precision. Do not round or relax the bound old/new process comparison.
        $nativeProcess=[Diagnostics.Process]::GetProcessById([int]$_.ProcessId)
        try {
          $null=$nativeProcess.Handle
          $nativeStart=$nativeProcess.StartTime.ToUniversalTime()
          if ($_.CreationDate -and [Math]::Abs(($_.CreationDate.ToUniversalTime()-$nativeStart).TotalSeconds) -gt 1) { throw 'REFERENCE_PROCESS_CHANGED' }
          $startUtc=$nativeStart.ToString('o')
        }
        finally { $nativeProcess.Dispose() }
      }
    }
    [PSCustomObject]@{
      pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;name=[string]$_.Name
      executable=[string]$_.ExecutablePath;commandLine=[string]$_.CommandLine
      startUtc=$startUtc
    }
  })
}
function Tasks {
  $items=@(Get-ScheduledTask -ErrorAction Stop)
  if ($items.Count -gt 8192) { throw 'REFERENCE_NATIVE_TASK_LIMIT' }
  if ($projectOnly) {
    # Retain-only operations bind the known project task and visible references;
    # unrelated task actions are not interpreted or claimed compatible.
    $needles=@($policy.roots | ForEach-Object { [string]$_.path }) + @($policy.windowsReferences.launchers | ForEach-Object { [IO.Path]::GetDirectoryName([string]$_.entry); [string]$_.workingDirectory })
    $items=@($items | Where-Object {
      $taskIdentity=[string]$_.TaskPath+[string]$_.TaskName
      if (@($effectScope.taskIdentities) -contains $taskIdentity) { return $true }
      foreach ($action in $_.Actions) {
        foreach ($text in @([string]$action.Execute,[string]$action.Arguments,[string]$action.WorkingDirectory)) {
          foreach ($needle in $needles) {
            if ($needle -and $text.Replace('/','\').IndexOf($needle.Replace('/','\'),[StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
          }
        }
      }
      return $false
    })
  }
  @($items | Sort-Object TaskPath,TaskName | ForEach-Object {
    Budget
    [PSCustomObject]@{
      identity=([string]$_.TaskPath+[string]$_.TaskName)
      actions=@($_.Actions | ForEach-Object {
        if ($preserving -and (([string]$_.Execute+[string]$_.Arguments+[string]$_.WorkingDirectory) -match '%[A-Za-z_][A-Za-z0-9_]*%')) { throw 'REFERENCE_NATIVE_TASK_ENVIRONMENT_UNCERTAIN' }
        [PSCustomObject]@{execute=(Expand-ReferenceText ([string]$_.Execute));arguments=(Expand-ReferenceText ([string]$_.Arguments));workingDirectory=(Expand-ReferenceText ([string]$_.WorkingDirectory))}
      })
    }
  })
}
$before=@();$after=@();$tasks=@();$tasksAfter=@()
try {
  $policyBytes=[IO.File]::ReadAllBytes($PolicyFile)
  $sha=[Security.Cryptography.SHA256]::Create()
  $policySha=([BitConverter]::ToString($sha.ComputeHash($policyBytes))).Replace('-','').ToLowerInvariant()
  $policy=[Text.Encoding]::UTF8.GetString($policyBytes) | ConvertFrom-Json
  $preserving=($policy.preservingUpdate.format -eq 1 -and $policy.preservingUpdate.operation -in @('build','install','restart'))
  $buildOnly=($preserving -and $policy.phase -eq 'build-only' -and $policy.preservingUpdate.operation -eq 'build' -and @($policy.preservingUpdate.effects).Count -eq 1 -and $policy.preservingUpdate.effects[0] -eq 'new-output-only')
  $effectScope=$policy.preservingUpdate.effectScope
  $projectOnly=($preserving -and -not $buildOnly -and $effectScope.format -eq 1)
  $projectNeedles=@($policy.roots | ForEach-Object { [string]$_.path }) + @($policy.windowsReferences.launchers | ForEach-Object { [IO.Path]::GetDirectoryName([string]$_.entry); [string]$_.workingDirectory })
  if ($preserving -and ($policy.preservingUpdate.operation -eq 'build' -or $policy.phase -eq 'build-only') -and -not $buildOnly) { throw 'REFERENCE_NATIVE_BUILD_CONTRACT_INVALID' }
  $before=@(Processes)
  if (-not $buildOnly) { $tasks=@(Tasks) }
  if (-not $preserving) {
  # Current and common known folders cover this single-user adapter. Additional
  # non-special profiles are an explicit incomplete scope, never silently skipped.
  $profiles=@(Get-CimInstance Win32_UserProfile -ErrorAction Stop | Where-Object { -not $_.Special })
  foreach ($userProfile in $profiles) {
    Budget
    if (-not [string]::Equals([string]$userProfile.LocalPath,$env:USERPROFILE,[StringComparison]::OrdinalIgnoreCase)) {
      throw 'REFERENCE_NATIVE_OTHER_PROFILE_REQUIRES_REVIEW'
    }
  }
  $folders=@('Desktop','CommonDesktopDirectory','StartMenu','CommonStartMenu','Startup','CommonStartup')
  $labels=@('Desktop','CommonDesktop','StartMenu','CommonStartMenu','Startup','CommonStartup')
  $seen=[System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $shell=New-Object -ComObject WScript.Shell
  try {
    for ($i=0;$i -lt $folders.Count;$i++) {
      Budget
      $folder=[Environment]::GetFolderPath([Enum]::Parse([Environment+SpecialFolder],$folders[$i]))
      if (-not $folder) { throw 'REFERENCE_NATIVE_KNOWN_FOLDER_UNKNOWN' }
      $rootProof=Directory-Proof $folder
      if ($null -eq $rootProof) {
        $parent=[IO.Path]::GetDirectoryName($folder)
        while ($parent -and $null -eq ($ancestor=Directory-Proof $parent)) {
          Budget
          $parent=[IO.Path]::GetDirectoryName($parent)
        }
        if (-not $parent -or $null -eq $ancestor) { throw 'REFERENCE_NATIVE_ABSENCE_ANCESTOR_UNKNOWN' }
        $relative=$folder.Substring($parent.Length).TrimStart([char]'\')
        $missing=[IO.Path]::Combine($ancestor.path,$relative)
        $coverage.Add([PSCustomObject]@{kind=$labels[$i];path=$missing;status='absent';ancestor=$ancestor})
        continue
      }
      $folder=$rootProof.path
      $pending=[System.Collections.Generic.Stack[string]]::new();$pending.Push($folder)
      while ($pending.Count) {
        Budget
        $at=$pending.Pop()
        $dirProof=Directory-Proof $at
        if ($null -eq $dirProof) { throw 'REFERENCE_NATIVE_SHORTCUT_DIRECTORY_CHANGED' }
        $at=$dirProof.path
        $dir=Get-Item -LiteralPath $at -Force -ErrorAction Stop
        if ($dir.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'REFERENCE_NATIVE_SHORTCUT_ALIAS_REQUIRES_REVIEW' }
        $entries=@(Get-ChildItem -LiteralPath $at -Force -ErrorAction Stop)
        if ($directorySnapshots.Count -ge 4096) { throw 'REFERENCE_NATIVE_SHORTCUT_DIRECTORY_LIMIT' }
        $directorySnapshots.Add([PSCustomObject]@{path=$at;identity=$dirProof.identity;entries=@($entries | ForEach-Object {
          [PSCustomObject]@{name=$_.Name;kind=$(if ($_.PSIsContainer) {'directory'} else {'file'})}
        })})
        foreach ($entry in $entries) {
          Budget
          if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'REFERENCE_NATIVE_SHORTCUT_ALIAS_REQUIRES_REVIEW' }
          if ($entry.PSIsContainer) { $pending.Push($entry.FullName);continue }
          if ($entry.Extension -ine '.lnk' -or -not $seen.Add($entry.FullName)) { continue }
          if ($seen.Count -gt 8192 -or $entry.Length -gt 1048576) { throw 'REFERENCE_NATIVE_SHORTCUT_LIMIT' }
          $hashBefore=(Get-FileHash -LiteralPath $entry.FullName -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
          $link=$shell.CreateShortcut($entry.FullName)
          try {
            $shortcuts.Add([PSCustomObject]@{path=$entry.FullName;sha256=$hashBefore;target=(Expand-ReferenceText ([string]$link.TargetPath));arguments=(Expand-ReferenceText ([string]$link.Arguments));workingDirectory=(Expand-ReferenceText ([string]$link.WorkingDirectory))})
          } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($link) }
          if ((Get-FileHash -LiteralPath $entry.FullName -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant() -ne $hashBefore) { throw 'REFERENCE_NATIVE_SHORTCUT_CHANGED' }
        }
      }
      $coverage.Add([PSCustomObject]@{kind=$labels[$i];path=$folder;status='enumerated';identity=$rootProof.identity})
    }
  } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
  }
  if (-not $buildOnly) { $tasksAfter=@(Tasks) }
  $after=@(Processes)
  Budget
} catch {
  $code=[string]$_.Exception.Message
  if ($code -notmatch '^REFERENCE_NATIVE_[A-Z_]+$') { $code='REFERENCE_NATIVE_QUERY_FAILED' }
  $errors.Add($code)
}
$complete=$errors.Count -eq 0
[PSCustomObject]@{
  format=$(if ($preserving) {2} else {1});complete=$(if ($preserving) {$false} else {$complete});observationComplete=$(if ($preserving) {$complete} else {$null});policySha256=$policySha
  categories=@{processes=$complete;tasks=$(if ($buildOnly) {'not_applicable'} else {$complete});shortcuts=$(if ($preserving) {'not_applicable'} else {$complete})}
  errors=@($errors.ToArray());processesBefore=@($before);processesAfter=@($after)
  tasks=@($tasks);tasksAfter=@($tasksAfter);shortcuts=@($shortcuts.ToArray());shortcutCoverage=@($coverage.ToArray())
  shortcutDirectories=@($directorySnapshots.ToArray())
} | ConvertTo-Json -Depth 8 -Compress
