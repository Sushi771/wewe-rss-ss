param([Parameter(Mandatory=$true)][string]$PolicyFile)
# Read-only host facts. No scripts/shortcuts/tasks are launched or modified.
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
Add-Type -LiteralPath (Join-Path $PSScriptRoot 'windows-reference-directory-identity.cs') -ErrorAction Stop
$errors=[System.Collections.Generic.List[string]]::new()
$coverage=[System.Collections.Generic.List[object]]::new()
$shortcuts=[System.Collections.Generic.List[object]]::new()
$directorySnapshots=[System.Collections.Generic.List[object]]::new()
$staticJunctions=[System.Collections.Generic.List[object]]::new()
$profileFacts=@();$profileFactsAfter=@();$scoped=$false
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
    [PSCustomObject]@{
      pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;name=[string]$_.Name
      executable=[string]$_.ExecutablePath;commandLine=[string]$_.CommandLine
      startUtc=$(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null })
    }
  })
}
function Tasks {
  $items=@(Get-ScheduledTask -ErrorAction Stop)
  if ($items.Count -gt 8192) { throw 'REFERENCE_NATIVE_TASK_LIMIT' }
  @($items | Sort-Object TaskPath,TaskName | ForEach-Object {
    Budget
    [PSCustomObject]@{
      identity=([string]$_.TaskPath+[string]$_.TaskName)
      actions=@($_.Actions | ForEach-Object {
        [PSCustomObject]@{execute=(Expand-ReferenceText ([string]$_.Execute));arguments=(Expand-ReferenceText ([string]$_.Arguments));workingDirectory=(Expand-ReferenceText ([string]$_.WorkingDirectory))}
      })
    }
  })
}
function Profile-Scope($profiles, [string]$current, $scope) {
  $other=@($profiles | Where-Object { -not $_.Special -and -not [string]::Equals([string]$_.LocalPath,$current,[StringComparison]::OrdinalIgnoreCase) })
  if ($null -eq $scope) {
    if ($other.Count) { throw 'REFERENCE_NATIVE_OTHER_PROFILE_REQUIRES_REVIEW' }
    return
  }
  if ($other.Count -ne @($scope.uninspectedProfiles).Count) { throw 'REFERENCE_NATIVE_PROFILE_SCOPE_CHANGED' }
  foreach ($p in $other) {
    $pin=@($scope.uninspectedProfiles | Where-Object { $_.sid -ceq [string]$p.SID })
    if ($pin.Count -ne 1 -or $p.Loaded -or [int]$p.Status -ne 0 -or
      -not [string]::Equals([string]$pin[0].path,[string]$p.LocalPath,[StringComparison]::OrdinalIgnoreCase) -or
      $pin[0].loaded -ne $false -or $pin[0].special -ne $false -or $pin[0].staticShortcutsInspected -ne $false) {
      throw 'REFERENCE_NATIVE_PROFILE_SCOPE_CHANGED'
    }
    [PSCustomObject]@{sid=[string]$p.SID;path=[string]$p.LocalPath;special=$false;loaded=$false;status=[int]$p.Status;staticShortcutsInspected=$false}
  }
}
$before=@();$after=@();$tasks=@();$tasksAfter=@()
try {
  $policyBytes=[IO.File]::ReadAllBytes($PolicyFile)
  $sha=[Security.Cryptography.SHA256]::Create()
  $policySha=([BitConverter]::ToString($sha.ComputeHash($policyBytes))).Replace('-','').ToLowerInvariant()
  $policy=[Text.Encoding]::UTF8.GetString($policyBytes) | ConvertFrom-Json
  $scope=$policy.windowsReferences.operationCoverage
  $scoped=$null -ne $scope
  if ($scoped -and ($scope.format -ne 1 -or $scope.kind -cne 'non-retiring-once-pair-v1' -or
    $scope.preserveLegacy -ne $true -or $scope.globalReferenceComplete -ne $false -or
    $policy.mode -cne 'once-frozen-pair-v1' -or ($policy.approval.operations -join '|') -cne 'install|publish|rollback' -or
    @($policy.pair).Count -ne 2 -or $policy.publication.limits.maxBackups -ne 1 -or
    $policy.publication.limits.maxPublications -ne 1 -or $policy.publication.limits.maxRollbacks -ne 1)) {
    throw 'REFERENCE_NATIVE_OPERATION_SCOPE_INVALID'
  }
  $before=@(Processes)
  $tasks=@(Tasks)
  # No profile directories, account ownership or impersonation tokens are queried.
  $profileFacts=@(Profile-Scope @(Get-CimInstance Win32_UserProfile -ErrorAction Stop) $env:USERPROFILE $scope)
  $folders=@('Desktop','CommonDesktopDirectory','StartMenu','CommonStartMenu','Startup','CommonStartup')
  $labels=@('Desktop','CommonDesktop','StartMenu','CommonStartMenu','Startup','CommonStartup')
  $seen=[System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $shell=New-Object -ComObject WScript.Shell
  try {
    for ($i=0;$i -lt $folders.Count;$i++) {
      Budget
      $folder=[Environment]::GetFolderPath([Enum]::Parse([Environment+SpecialFolder],$folders[$i]))
      if (-not $folder) { throw 'REFERENCE_NATIVE_KNOWN_FOLDER_UNKNOWN' }
      $staticOnly=$scoped -and $labels[$i] -notin @('Startup','CommonStartup')
      if ($staticOnly -and (Test-Path -LiteralPath $folder) -and ((Get-Item -LiteralPath $folder -Force -ErrorAction Stop).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        $staticJunctions.Add([PSCustomObject]@{path=$folder;inspected=$false;reason='unrelated-static-junction'})
        $coverage.Add([PSCustomObject]@{kind=$labels[$i];path=$folder;status='uninspected-static-junction'})
        continue
      }
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
          [PSCustomObject]@{name=$_.Name;kind=$(if ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) {'junction'} elseif ($_.PSIsContainer) {'directory'} else {'file'})}
        })})
        foreach ($entry in $entries) {
          Budget
          if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            if (-not $staticOnly -or -not $entry.PSIsContainer) { throw 'REFERENCE_NATIVE_SHORTCUT_ALIAS_REQUIRES_REVIEW' }
            $staticJunctions.Add([PSCustomObject]@{path=$entry.FullName;inspected=$false;reason='unrelated-static-junction'})
            continue
          }
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
  $tasksAfter=@(Tasks)
  $after=@(Processes)
  if ($scoped) { $profileFactsAfter=@(Profile-Scope @(Get-CimInstance Win32_UserProfile -ErrorAction Stop) $env:USERPROFILE $scope) }
  Budget
} catch {
  $code=[string]$_.Exception.Message
  if ($code -notmatch '^REFERENCE_NATIVE_[A-Z_]+$') { $code='REFERENCE_NATIVE_QUERY_FAILED' }
  $errors.Add($code)
}
$sufficient=$errors.Count -eq 0
$complete=$sufficient -and -not $scoped
[PSCustomObject]@{
  format=1;complete=$complete;policySha256=$policySha
  operationSufficient=($scoped -and $sufficient);globalReferenceComplete=$complete
  operationCoverage=$(if ($scoped) { @{kind='non-retiring-once-pair-v1';profilesBefore=@($profileFacts);profilesAfter=@($profileFactsAfter);staticJunctions=@($staticJunctions.ToArray())} } else {$null})
  categories=@{processes=$sufficient;tasks=$sufficient;shortcuts=$complete}
  errors=@($errors.ToArray());processesBefore=@($before);processesAfter=@($after)
  tasks=@($tasks);tasksAfter=@($tasksAfter);shortcuts=@($shortcuts.ToArray());shortcutCoverage=@($coverage.ToArray())
  shortcutDirectories=@($directorySnapshots.ToArray())
} | ConvertTo-Json -Depth 8 -Compress
