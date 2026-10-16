param([Parameter(Mandatory=$true)][string]$PolicyFile)
# Read-only host facts. No scripts/shortcuts/tasks are launched or modified.
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
Add-Type -LiteralPath (Join-Path $PSScriptRoot 'windows-reference-directory-identity.cs') -ErrorAction Stop
$errors=[System.Collections.Generic.List[string]]::new()
$coverage=[System.Collections.Generic.List[object]]::new()
$shortcuts=[System.Collections.Generic.List[object]]::new()
$directorySnapshots=[System.Collections.Generic.List[object]]::new()
$profileFacts=@();$profileFactsAfter=@();$scoped=$false
$processScoped=$false;$listenersBefore=@();$listenersAfter=@()
$diagnosticContext=[PSCustomObject]@{stage='policy-read';folderKind=$null;failure=$null}
$deadline=[DateTime]::UtcNow.AddSeconds(16)
function Reference-Stage([string]$stage,[string]$folderKind) {
  $diagnosticContext.stage=$stage
  $diagnosticContext.folderKind=$folderKind
}
function Reference-Failure($record) {
  if ($null -ne $diagnosticContext.failure) {return}
  $chain=[System.Collections.Generic.List[object]]::new()
  $exception=$record.Exception
  while ($null -ne $exception -and $chain.Count -lt 4) {
    $type=$exception.GetType().FullName
    if ($type -notmatch '^(System|Microsoft)\.[A-Za-z0-9_.+]{1,150}$') {$type='OtherException'}
    $chain.Add([PSCustomObject]@{type=$type;hresult=('0x{0:X8}' -f $exception.HResult);nativeErrorCode=$(if($exception -is [ComponentModel.Win32Exception]) {$exception.NativeErrorCode} else {$null})})
    $exception=$exception.InnerException
  }
  $errorId=([string]$record.FullyQualifiedErrorId -split ',')[0]
  if ($errorId -notmatch '^[A-Za-z][A-Za-z0-9_.-]{0,95}$') {$errorId='OtherError'}
  # No message, pathname, command, target, arguments, stack or source text.
  $diagnosticContext.failure=[PSCustomObject]@{stage=$diagnosticContext.stage;folderKind=$diagnosticContext.folderKind;errorId=$errorId;category=[string]$record.CategoryInfo.Category;exceptions=@($chain.ToArray())}
}
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
function Task-Digest($value) {
  $text=ConvertTo-Json -InputObject $value -Depth 8 -Compress
  if([Text.Encoding]::UTF8.GetByteCount($text) -gt 65536){throw 'REFERENCE_NATIVE_TASK_METADATA_LIMIT'}
  $h=[Security.Cryptography.SHA256]::Create()
  try {([BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($text)))).Replace('-','').ToLowerInvariant()} finally {$h.Dispose()}
}
function Tasks {
  $items=@(Get-ScheduledTask -ErrorAction Stop)
  if ($items.Count -gt 8192) { throw 'REFERENCE_NATIVE_TASK_LIMIT' }
  @($items | Sort-Object TaskPath,TaskName | ForEach-Object {
    Budget
    $identity=([string]$_.TaskPath+[string]$_.TaskName)
    if(@($_.Actions).Count -gt 64){throw 'REFERENCE_NATIVE_TASK_METADATA_LIMIT'}
    $actions=@($_.Actions | ForEach-Object {
      Budget
      $class=[string]$_.CimClass.CimClassName
      $kind=switch -Exact ($class) {'MSFT_TaskExecAction' {'exec'} 'MSFT_TaskComHandlerAction' {'com-handler'} default {'unknown'}}
      $row=[ordered]@{execute=(Expand-ReferenceText ([string]$_.Execute));arguments=(Expand-ReferenceText ([string]$_.Arguments));workingDirectory=(Expand-ReferenceText ([string]$_.WorkingDirectory));actionType=$kind;cimClass=$class;id=[string]$_.Id;classId=[string]$_.ClassId;data=[string]$_.Data}
      foreach($v in $row.Values){if(([string]$v).Length -gt 32768){throw 'REFERENCE_NATIVE_TASK_METADATA_LIMIT'}}
      $row.identitySha256=Task-Digest $row
      [PSCustomObject]$row
    })
    [PSCustomObject]@{identity=$identity;actions=$actions;actionsSha256=(Task-Digest ([ordered]@{identity=$identity;actions=$actions}))}
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
function Shortcut-Sha256([string]$file) {
  $stream=$null;$hasher=$null
  try {
    Budget
    $stream=[IO.File]::OpenRead($file)
    $hasher=[Security.Cryptography.SHA256]::Create()
    $buffer=[byte[]]::new(1048577);$length=0
    while (($count=$stream.Read($buffer,$length,$buffer.Length-$length)) -gt 0) {
      $length+=$count
      if ($length -gt 1048576) {throw 'REFERENCE_NATIVE_SHORTCUT_LIMIT'}
      Budget
    }
    ([BitConverter]::ToString($hasher.ComputeHash($buffer,0,$length))).Replace('-','').ToLowerInvariant()
  } finally {
    if($null -ne $stream){$stream.Dispose()}
    if($null -ne $hasher){$hasher.Dispose()}
  }
}
function Read-Shortcut($entry,$shell) {
  if ($entry.Extension -ine '.lnk' -or -not $seen.Add($entry.FullName)) { return }
  if ($seen.Count -gt 8192 -or $entry.Length -gt 1048576) { throw 'REFERENCE_NATIVE_SHORTCUT_LIMIT' }
  Reference-Stage 'shortcut-hash-before' $diagnosticContext.folderKind
  $hashBefore=Shortcut-Sha256 $entry.FullName
  Reference-Stage 'shortcut-com-create' $diagnosticContext.folderKind
  $link=$shell.CreateShortcut($entry.FullName)
  try {
    Reference-Stage 'shortcut-com-fields' $diagnosticContext.folderKind
    $shortcuts.Add([PSCustomObject]@{path=$entry.FullName;sha256=$hashBefore;target=(Expand-ReferenceText ([string]$link.TargetPath));arguments=(Expand-ReferenceText ([string]$link.Arguments));workingDirectory=(Expand-ReferenceText ([string]$link.WorkingDirectory))})
  } catch {Reference-Failure $_;throw}
  finally {
    Reference-Stage 'shortcut-com-release' $diagnosticContext.folderKind
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($link)
  }
  Reference-Stage 'shortcut-hash-after' $diagnosticContext.folderKind
  if ((Shortcut-Sha256 $entry.FullName) -ne $hashBefore) { throw 'REFERENCE_NATIVE_SHORTCUT_CHANGED' }
}
function Operation-Listeners {
  $port=[int]$policy.publication.expected.port
  $rows=@(Get-LocalTcpListener -Port $port)
  if($rows.Count -gt 64){throw 'REFERENCE_NATIVE_OPERATION_PORT_LIMIT'}
  @($rows | ForEach-Object {
    Budget
    [PSCustomObject]@{port=[int]$_.LocalPort;pid=[int]$_.OwningProcess;address=[string]$_.LocalAddress}
  })
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
    $scope.staticScopeMode -cne 'startup-and-pinned-launchers-v1' -or
    $scope.preserveLegacy -ne $true -or $scope.globalReferenceComplete -ne $false -or
    $policy.mode -cne 'once-frozen-pair-v1' -or ($policy.approval.operations -join '|') -cne 'install|publish|rollback' -or
    @($policy.pair).Count -ne 2 -or $policy.publication.limits.maxBackups -ne 1 -or
    $policy.publication.limits.maxPublications -ne 1 -or $policy.publication.limits.maxRollbacks -ne 1)) {
    throw 'REFERENCE_NATIVE_OPERATION_SCOPE_INVALID'
  }
  $processScoped=$scoped -and $null -ne $scope.processCoverage
  if($processScoped){
    if($scope.processCoverage.format -ne 1 -or $scope.processCoverage.kind -cne 'once-related-processes-v1' -or
      $scope.processCoverage.globalDbWriterExclusion -ne $false -or
      $scope.processCoverage.coverageClaim -cne 'related-processes-only;uninspected-background-db-access-unproven' -or
      [int]$policy.publication.expected.port -lt 1 -or [int]$policy.publication.expected.port -gt 65535){throw 'REFERENCE_NATIVE_PROCESS_SCOPE_INVALID'}
    Reference-Stage 'operation-port-helper' $null
    $tcp=Join-Path $PSScriptRoot 'tcp-listeners.ps1'
    if((Shortcut-Sha256 $tcp) -cne $policy.codePins.'tcp-listeners.ps1'){throw 'REFERENCE_NATIVE_TCP_HELPER_PIN_CHANGED'}
    . $tcp
    Reference-Stage 'operation-port-before' $null
    $listenersBefore=@(Operation-Listeners)
  }
  Reference-Stage 'processes-before' $null
  $before=@(Processes)
  Reference-Stage 'tasks-before' $null
  $tasks=@(Tasks)
  # No profile directories, account ownership or impersonation tokens are queried.
  Reference-Stage 'profiles-before' $null
  $profileFacts=@(Profile-Scope @(Get-CimInstance Win32_UserProfile -ErrorAction Stop) $env:USERPROFILE $scope)
  $folders=@('Desktop','CommonDesktopDirectory','StartMenu','CommonStartMenu','Startup','CommonStartup')
  $labels=@('Desktop','CommonDesktop','StartMenu','CommonStartMenu','Startup','CommonStartup')
  $seen=[System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  Reference-Stage 'shortcut-shell-create' $null
  $shell=New-Object -ComObject WScript.Shell
  try {
    for ($i=0;$i -lt $folders.Count;$i++) {
      Budget
      # Static desktop/start-menu trees are not inputs to non-retiring operations.
      # Do not even resolve/open these roots; record the entire uninspected scope.
      if ($scoped -and $labels[$i] -notin @('Startup','CommonStartup')) {
        $coverage.Add([PSCustomObject]@{kind=$labels[$i];status='not-inspected-operation-scope';inspected=$false;reason='outside-non-retiring-operation'})
        continue
      }
      Reference-Stage 'known-folder' $labels[$i]
      $folder=[Environment]::GetFolderPath([Enum]::Parse([Environment+SpecialFolder],$folders[$i]))
      if (-not $folder) { throw 'REFERENCE_NATIVE_KNOWN_FOLDER_UNKNOWN' }
      Reference-Stage 'directory-proof' $labels[$i]
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
        Reference-Stage 'directory-metadata' $labels[$i]
        $dir=Get-Item -LiteralPath $at -Force -ErrorAction Stop
        if ($dir.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'REFERENCE_NATIVE_SHORTCUT_ALIAS_REQUIRES_REVIEW' }
        Reference-Stage 'directory-enumeration' $labels[$i]
        $entries=@(Get-ChildItem -LiteralPath $at -Force -ErrorAction Stop)
        if ($directorySnapshots.Count -ge 4096) { throw 'REFERENCE_NATIVE_SHORTCUT_DIRECTORY_LIMIT' }
        $directorySnapshots.Add([PSCustomObject]@{path=$at;identity=$dirProof.identity;entries=@($entries | ForEach-Object {
          [PSCustomObject]@{name=$_.Name;kind=$(if ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) {'junction'} elseif ($_.PSIsContainer) {'directory'} else {'file'})}
        })})
        foreach ($entry in $entries) {
          Budget
          if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw 'REFERENCE_NATIVE_SHORTCUT_ALIAS_REQUIRES_REVIEW'
          }
          if ($entry.PSIsContainer) { $pending.Push($entry.FullName);continue }
          Read-Shortcut $entry $shell
        }
      }
      $coverage.Add([PSCustomObject]@{kind=$labels[$i];path=$folder;status='enumerated';identity=$rootProof.identity})
    }
    if ($scoped) {
      if (@($policy.windowsReferences.launchers).Count -gt 16) {throw 'REFERENCE_NATIVE_LAUNCHER_LIMIT'}
      foreach($launcher in $policy.windowsReferences.launchers) {
        if (@($launcher.files).Count -gt 128) {throw 'REFERENCE_NATIVE_LAUNCHER_LIMIT'}
        foreach($pin in $launcher.files) {
          if ([IO.Path]::GetExtension([string]$pin.path) -ine '.lnk') {continue}
          Budget
          Reference-Stage 'pinned-entry-metadata' 'PinnedLauncher'
          if (-not [IO.Path]::IsPathRooted([string]$pin.path) -or $pin.sha256 -notmatch '^[a-f0-9]{64}$') {throw 'REFERENCE_NATIVE_PINNED_SHORTCUT_INVALID'}
          $entry=Get-Item -LiteralPath $pin.path -Force -ErrorAction Stop
          if ($entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) {throw 'REFERENCE_NATIVE_SHORTCUT_ALIAS_REQUIRES_REVIEW'}
          Read-Shortcut $entry $shell
          Reference-Stage 'pinned-entry-verify' 'PinnedLauncher'
          $found=@($shortcuts | Where-Object { $_.path -ieq $entry.FullName })
          if ($found.Count -ne 1 -or $found[0].sha256 -cne $pin.sha256) {throw 'REFERENCE_NATIVE_PINNED_SHORTCUT_CHANGED'}
        }
      }
    }
  } catch {Reference-Failure $_;throw}
  finally {
    Reference-Stage 'shortcut-shell-release' $null
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
  }
  Reference-Stage 'tasks-after' $null
  $tasksAfter=@(Tasks)
  Reference-Stage 'processes-after' $null
  $after=@(Processes)
  if ($scoped) {
    Reference-Stage 'profiles-after' $null
    $profileFactsAfter=@(Profile-Scope @(Get-CimInstance Win32_UserProfile -ErrorAction Stop) $env:USERPROFILE $scope)
  }
  if($processScoped){
    Reference-Stage 'operation-port-after' $null
    $listenersAfter=@(Operation-Listeners)
  }
  Budget
} catch {
  Reference-Failure $_
  $code=[string]$_.Exception.Message
  if ($code -notmatch '^REFERENCE_NATIVE_[A-Z_]+$') { $code='REFERENCE_NATIVE_QUERY_FAILED' }
  $errors.Add($code)
}
$sufficient=$errors.Count -eq 0
$complete=$sufficient -and -not $scoped
[PSCustomObject]@{
  format=1;complete=$complete;policySha256=$policySha
  operationSufficient=($scoped -and $sufficient);globalReferenceComplete=$complete
  operationCoverage=$(if ($scoped) { @{kind='non-retiring-once-pair-v1';staticScopeMode=$scope.staticScopeMode;profilesBefore=@($profileFacts);profilesAfter=@($profileFactsAfter);staticJunctions=@()} } else {$null})
  categories=@{processes=$sufficient;tasks=$sufficient;shortcuts=$complete}
  failureContext=$diagnosticContext.failure
  processCoverage=$(if($processScoped){@{format=1;port=[int]$policy.publication.expected.port;listenersBefore=@($listenersBefore);listenersAfter=@($listenersAfter)}}else{$null})
  errors=@($errors.ToArray());processesBefore=@($before);processesAfter=@($after)
  tasks=@($tasks);tasksAfter=@($tasksAfter);shortcuts=@($shortcuts.ToArray());shortcutCoverage=@($coverage.ToArray())
  shortcutDirectories=@($directorySnapshots.ToArray())
} | ConvertTo-Json -Depth 8 -Compress
