param([string]$Source,[string]$FixtureFile)
# Test-only boundaries. Execute the actual collector body against owned paths and
# synthetic CIM/task/COM facts. No host profile/process/task query is permitted.
$ErrorActionPreference='Stop'
$global:OwnedFixture=Get-Content -LiteralPath $FixtureFile -Raw | ConvertFrom-Json
$global:OwnedHelperRoot=$global:OwnedFixture.helperRoot
$src=Get-Content -LiteralPath $Source -Raw
$folderCall='[Environment]::GetFolderPath([Enum]::Parse([Environment+SpecialFolder],$folders[$i]))'
if (($src.Split(@($folderCall),[StringSplitOptions]::None).Count-1) -ne 1) { throw 'folder boundary changed' }
$src=$src.Replace($folderCall,'(Owned-KnownFolder $folders[$i])')
$helperCall="Add-Type -LiteralPath (Join-Path `$PSScriptRoot 'windows-reference-directory-identity.cs') -ErrorAction Stop"
if (-not $src.Contains($helperCall)) { throw 'helper boundary changed' }
$src=$src.Replace($helperCall,"if (-not ('WeWeReferenceDirectoryIdentity' -as [type])) { Add-Type -LiteralPath (Join-Path `$global:OwnedHelperRoot 'windows-reference-directory-identity.cs') -ErrorAction Stop }")
foreach($item in @('$shell','$link')) {
  $release='[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject('+$item+')'
  if (-not $src.Contains($release)) { throw 'COM release boundary changed' }
  $src=$src.Replace($release,'[void](Owned-ReleaseCom '+$item+')')
}
$hashCall='Shortcut-Sha256 $entry.FullName'
if (($src.Split(@($hashCall),[StringSplitOptions]::None).Count-1) -ne 2) {throw 'hash boundary changed'}
$src=$src.Replace($hashCall,'Owned-ShortcutHash $entry.FullName')
$collector=[scriptblock]::Create($src)
function Owned-Path([string]$at) {
  $root=[IO.Path]::GetFullPath($global:OwnedFixture.root).TrimEnd('\')+'\'
  $full=[IO.Path]::GetFullPath($at)
  if (-not $full.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) { throw 'REFERENCE_NATIVE_FIXTURE_ESCAPE' }
  foreach($static in $global:OwnedFixture.staticRoots) {
    if ($full -eq $static -or $full.StartsWith($static+'\',[StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}
function Owned-KnownFolder([string]$name) {
  $global:OwnedCounts.resolved.Add($name)
  if($global:OwnedCase -eq 'deadline' -and $name -eq 'Startup') {
    Set-Variable -Name deadline -Value ([DateTime]::UtcNow.AddSeconds(-1)) -Scope 1
  }
  $global:OwnedFixture.folders.$name
}
function Get-CimInstance($ClassName,$ErrorAction) {
  if ($ClassName -eq 'Win32_Process') {
    $global:OwnedCounts.processes++
    if($global:OwnedCase -eq 'denied-post-process' -and $global:OwnedCounts.processes -eq 2) { throw 'necessary query denied' }
    foreach($p in $global:OwnedFixture.processes) {
      [PSCustomObject]@{ProcessId=$p.pid;ParentProcessId=$p.parentPid;Name=$p.name;ExecutablePath=$p.executable;CommandLine=$p.commandLine;CreationDate=[DateTime]::Parse($p.startUtc).ToUniversalTime()}
    }
  } elseif ($ClassName -eq 'Win32_UserProfile') {
    $global:OwnedCounts.profiles++
    if($global:OwnedCase -ne 'default-strict') {
      foreach($p in $global:OwnedFixture.profiles) {
        [PSCustomObject]@{SID=$p.sid;LocalPath=$p.path;Special=$p.special;Loaded=$p.loaded;Status=$p.status}
      }
    }
  } else { throw 'unexpected CIM class' }
}
function Get-ScheduledTask($ErrorAction) {
  $global:OwnedCounts.tasks++
  foreach($t in $global:OwnedFixture.tasks) { [PSCustomObject]@{TaskPath='\';TaskName=$t.identity;Actions=$t.actions} }
}
function Get-Item($LiteralPath,[switch]$Force,$ErrorAction) {
  if (Owned-Path $LiteralPath) { $global:OwnedCounts.staticMetadata++ }
  if($global:OwnedCase -eq 'denied-pinned-entry' -and $LiteralPath -eq $global:OwnedFixture.explicitEntry) {throw 'necessary pinned entry denied'}
  Microsoft.PowerShell.Management\Get-Item -LiteralPath $LiteralPath -Force -ErrorAction Stop
}
function Get-ChildItem($LiteralPath,[switch]$Force,$ErrorAction) {
  if (Owned-Path $LiteralPath) {
    $global:OwnedCounts.staticEnumerations++
    throw 'REFERENCE_NATIVE_UNRELATED_STATIC_TRAVERSAL'
  }
  $global:OwnedCounts.enumerated.Add($LiteralPath)
  if($global:OwnedCase -eq 'denied-startup') { throw 'necessary Startup query denied' }
  $entries=@(Microsoft.PowerShell.Management\Get-ChildItem -LiteralPath $LiteralPath -Force -ErrorAction Stop)
  if($global:OwnedCase -eq 'missing-startup-entry' -and $entries.Count) {
    if(Owned-Path $entries[0].FullName) {throw 'wrong fixture delete'}
    [IO.File]::Delete($entries[0].FullName)
  }
  $entries
}
function Get-FileHash {
  $global:OwnedCounts.hashCmdletCalls++
  throw [Management.Automation.CommandNotFoundException]::new('Unavailable optional hash command')
}
function Owned-ShortcutHash($LiteralPath) {
  if (Owned-Path $LiteralPath) { $global:OwnedCounts.staticHashes++;throw 'REFERENCE_NATIVE_UNRELATED_STATIC_HASH' }
  $global:OwnedCounts.hashes++
  if($global:OwnedCase -eq 'denied-shortcut-hash') {throw [UnauthorizedAccessException]::new('SECRET_FIXTURE_PATH must not leak')}
  if($global:OwnedCase -eq 'oversize-shortcut-hash') {[IO.File]::WriteAllBytes($LiteralPath,[byte[]]::new(1048577))}
  if($global:OwnedCase -eq 'changed-pinned-entry' -and $LiteralPath -eq $global:OwnedFixture.explicitEntry) {[IO.File]::WriteAllText($LiteralPath,'changed pinned fixture')}
  if($global:OwnedCase -eq 'changed-startup-entry' -and $global:OwnedCounts.hashes -eq 2) {
    [IO.File]::WriteAllText($LiteralPath,'changed Startup fixture')
  }
  Shortcut-Sha256 $LiteralPath
}
function New-Object($ComObject) {
  if($ComObject -ne 'WScript.Shell') {throw 'unexpected COM object'}
  $shell=[PSCustomObject]@{}
  $shell | Add-Member ScriptMethod CreateShortcut {
    param($at)
    if (Owned-Path $at) { $global:OwnedCounts.staticCom++;throw 'REFERENCE_NATIVE_UNRELATED_STATIC_COM' }
    $global:OwnedCounts.com++
    if($global:OwnedCase -eq 'com-create-failure') {throw [Runtime.InteropServices.COMException]::new('SECRET_FIXTURE_TARGET must not leak',-2147024891)}
    $r=$global:OwnedFixture.links.$at
    if($null -eq $r) {throw 'unknown fixture shortcut'}
    [PSCustomObject]@{TargetPath=$r.target;Arguments=$r.arguments;WorkingDirectory=$r.workingDirectory}
  }
  $shell
}
function Owned-ReleaseCom($value) {}
$results=[System.Collections.Generic.List[object]]::new()
$positive=$null
foreach($case in @('success','get-filehash-unavailable','default-strict','denied-startup','changed-startup-entry','missing-startup-entry','denied-pinned-entry','changed-pinned-entry','denied-post-process','deadline','denied-shortcut-hash','oversize-shortcut-hash','com-create-failure')) {
  $global:OwnedCase=$case
  $global:OwnedCounts=@{processes=0;tasks=0;profiles=0;staticMetadata=0;staticEnumerations=0;staticHashes=0;staticCom=0;hashes=0;hashCmdletCalls=0;com=0;resolved=[System.Collections.Generic.List[string]]::new();enumerated=[System.Collections.Generic.List[string]]::new()}
  foreach($file in $global:OwnedFixture.links.PSObject.Properties.Name) {
    if(Owned-Path $file) {throw 'bad Startup fixture'}
    [IO.File]::WriteAllText($file,'inert synthetic shortcut')
  }
  $policy=$(if($case -eq 'default-strict') {$global:OwnedFixture.defaultPolicy} else {$global:OwnedFixture.policy})
  $raw=& $collector -PolicyFile $policy
  $r=$raw | ConvertFrom-Json
  if($case -eq 'success') {$positive=$r}
  $results.Add([PSCustomObject]@{name=$case;counts=$global:OwnedCounts;failureContext=$r.failureContext;complete=$r.complete;operationSufficient=$r.operationSufficient;globalReferenceComplete=$r.globalReferenceComplete;errors=$r.errors;processesAfter=@($r.processesAfter).Count;tasksAfter=@($r.tasksAfter).Count;profilesAfter=@($r.operationCoverage.profilesAfter).Count;directoryCount=@($r.shortcutDirectories).Count;shortcutCount=@($r.shortcuts).Count})
}
@{results=@($results.ToArray());native=$positive} | ConvertTo-Json -Depth 12 -Compress
