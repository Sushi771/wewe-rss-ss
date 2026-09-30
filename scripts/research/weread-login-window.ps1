# One-session Windows launcher for a visible official WeRead login window.
# Plan and SelfTest are offline. Start is deliberately opt-in and is not a product service.
param(
  [ValidateSet('Plan', 'SelfTest', 'Start', 'Status', 'Stop')]
  [string]$Action = 'Plan',
  [ValidateSet('Edge', 'Chrome')]
  [string]$Browser = 'Edge',
  # An independently discovered original may be opened by the owner solely
  # for normal official validation. This does not clear any request stop.
  [string]$EntryUrl = 'https://weread.qq.com/'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function SessionRoot {
  if (-not $env:LOCALAPPDATA) { throw 'LOCAL_APP_DATA_MISSING' }
  return Join-Path $env:LOCALAPPDATA 'WeWe-RSS\research-weread-browser'
}

function BrowserCandidates([string]$name) {
  $relative = if ($name -eq 'Edge') { 'Microsoft\Edge\Application\msedge.exe' }
    else { 'Google\Chrome\Application\chrome.exe' }
  $roots = @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:LOCALAPPDATA) |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  foreach ($root in $roots) { Join-Path $root $relative }
}

function FindSignedBrowser([string]$name) {
  $expected = if ($name -eq 'Edge') { 'Microsoft' } else { 'Google' }
  foreach ($candidate in (BrowserCandidates $name)) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    $signature = Get-AuthenticodeSignature -LiteralPath $candidate
    if ($signature.Status -ne 'Valid' -or
      -not $signature.SignerCertificate -or
      $signature.SignerCertificate.Subject -notmatch $expected) { continue }
    return [IO.Path]::GetFullPath($candidate)
  }
  throw 'SIGNED_BROWSER_NOT_FOUND'
}

function AssertBrowserPolicy([string]$name) {
  $vendor = if ($name -eq 'Edge') { 'Microsoft\Edge' } else { 'Google\Chrome' }
  foreach ($hive in @('HKLM:', 'HKCU:')) {
    $policy = Get-ItemProperty -LiteralPath "$hive\SOFTWARE\Policies\$vendor" -ErrorAction SilentlyContinue
    if (-not $policy) { continue }
    if ($policy.PSObject.Properties.Name -contains 'UserDataDir') {
      throw 'USER_DATA_DIR_POLICY_OVERRIDES_ISOLATION'
    }
    if (($policy.PSObject.Properties.Name -contains 'RemoteDebuggingAllowed') -and
      [int]$policy.RemoteDebuggingAllowed -eq 0) {
      throw 'REMOTE_DEBUGGING_DISABLED_BY_POLICY'
    }
  }
}

function AssertPrivateAcl([string]$directory) {
  # Everyone, authenticated users, Users, and broad app-package groups.
  $forbidden = @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545', 'S-1-15-2-1', 'S-1-15-2-2')
  $acl = Get-Acl -LiteralPath $directory
  foreach ($rule in $acl.Access) {
    if ($rule.AccessControlType -ne 'Allow') { continue }
    try {
      $sid = $rule.IdentityReference.Translate(
        [System.Security.Principal.SecurityIdentifier]
      ).Value
    } catch { throw 'PRIVATE_DIRECTORY_ACL_UNVERIFIED' }
    if ($sid -in $forbidden) { throw 'PRIVATE_DIRECTORY_SHARED_ACL' }
  }
}

function AssertNoReparseAncestors([string]$path) {
  $current = [IO.Path]::GetFullPath($path)
  while ($current) {
    $item = Get-Item -LiteralPath $current -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw 'REPARSE_POINT_IN_SESSION_PATH'
    }
    $parent = [IO.Path]::GetDirectoryName($current.TrimEnd('\'))
    if (-not $parent -or [string]::Equals($parent, $current,
        [StringComparison]::OrdinalIgnoreCase)) { break }
    $current = $parent
  }
}

function IsDirectChild([string]$root, [string]$candidate) {
  $base = [IO.Path]::GetFullPath($root).TrimEnd('\')
  $target = [IO.Path]::GetFullPath($candidate).TrimEnd('\')
  return [string]::Equals([IO.Path]::GetDirectoryName($target), $base,
    [StringComparison]::OrdinalIgnoreCase) -and
    [IO.Path]::GetFileName($target) -match '^session-[0-9a-f]{32}$'
}

function LaunchArguments([string]$profile) {
  if ($profile.Contains('"')) { throw 'PROFILE_PATH_INVALID' }
  $entry = [Uri]$EntryUrl
  if ($entry.Scheme -ne 'https' -or $entry.UserInfo -or -not $entry.IsDefaultPort -or
      $EntryUrl -match '[\s"\\]' -or
      -not (($entry.Host -eq 'weread.qq.com' -and $entry.AbsolutePath -eq '/') -or
        ($entry.Host -eq 'mp.weixin.qq.com' -and $entry.AbsolutePath -eq '/s' -and
          $entry.Query -match '(^\?|&)__biz=' -and $entry.Query -match '&mid=\d+' -and
          $entry.Query -match '&idx=[1-9]\d*' -and $entry.Query -match '&sn=[a-fA-F0-9]+'))) {
    throw 'OFFICIAL_ENTRY_URL_INVALID'
  }
  return @(
    "--user-data-dir=`"$profile`""
    '--remote-debugging-address=127.0.0.1'
    '--remote-debugging-port=0'
    '--no-first-run'
    '--no-default-browser-check'
    '--new-window'
    $EntryUrl
  )
}

function IsLoopbackOnly($listeners) {
  $items = @($listeners)
  return $items.Count -gt 0 -and
    @($items | Where-Object { $_.LocalAddress -ne '127.0.0.1' }).Count -eq 0
}

function StateFile {
  return Join-Path (SessionRoot) 'session.json'
}

function ReadSession {
  $file = StateFile
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'NO_ACTIVE_SESSION' }
  $state = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
  if (-not $state -or $state.browser -notin @('Edge', 'Chrome') -or
    -not (($state.pid -is [int]) -or ($state.pid -is [long])) -or $state.pid -lt 1 -or
    -not ($state.profile -is [string]) -or
    -not (IsDirectChild (SessionRoot) $state.profile) -or
    -not ($state.executable -is [string])) { throw 'SESSION_STATE_INVALID' }
  if (-not [string]::Equals((FindSignedBrowser $state.browser),
      [IO.Path]::GetFullPath($state.executable),
      [StringComparison]::OrdinalIgnoreCase)) { throw 'SESSION_BROWSER_MISMATCH' }
  return $state
}

function ProcessMatchesSession($state) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($state.pid)" -ErrorAction SilentlyContinue
  if (-not $process) { return $false }
  $expectedArg = "--user-data-dir=`"$($state.profile)`""
  return [string]::Equals($process.ExecutablePath, $state.executable,
    [StringComparison]::OrdinalIgnoreCase) -and
    $process.CommandLine.Contains($expectedArg)
}

function AnyBrowserUsingProfile($state) {
  $items = Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe' OR Name = 'chrome.exe'"
  foreach ($item in $items) {
    if ($item.CommandLine -and $item.CommandLine.Contains($state.profile)) { return $true }
  }
  return $false
}

function SessionPort($state) {
  $file = Join-Path $state.profile 'DevToolsActivePort'
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $null }
  # The second line is a browser WebSocket identifier. Do not read or print it.
  $first = Get-Content -LiteralPath $file -TotalCount 1
  if ($first -notmatch '^\d{1,5}$') { throw 'CDP_PORT_FILE_INVALID' }
  $port = [int]$first
  if ($port -lt 1 -or $port -gt 65535) { throw 'CDP_PORT_FILE_INVALID' }
  return $port
}

function VerifiedPort($state) {
  $port = SessionPort $state
  if (-not $port) { return $null }
  $listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
  if (-not (IsLoopbackOnly $listeners)) { throw 'CDP_NOT_IPV4_LOOPBACK_ONLY' }
  foreach ($listener in $listeners) {
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
    if (-not $owner -or
      -not [string]::Equals($owner.ExecutablePath, $state.executable,
        [StringComparison]::OrdinalIgnoreCase) -or
      ($owner.ProcessId -ne $state.pid -and
        (-not $owner.CommandLine -or -not $owner.CommandLine.Contains($state.profile)))) {
      throw 'CDP_PORT_OWNER_UNVERIFIED'
    }
  }
  return $port
}

function CleanupStoppedSession($state) {
  $root = SessionRoot
  if (-not (IsDirectChild $root $state.profile)) { throw 'PROFILE_OUTSIDE_SESSION_ROOT' }
  AssertNoReparseAncestors $state.profile
  $rootInfo = Get-Item -LiteralPath $root -Force
  $profileInfo = Get-Item -LiteralPath $state.profile -Force
  if (($rootInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
    ($profileInfo.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'REPARSE_POINT_CLEANUP_REFUSED'
  }
  $resolvedRoot = [IO.Path]::GetFullPath($rootInfo.FullName)
  $resolvedProfile = [IO.Path]::GetFullPath($profileInfo.FullName)
  if (-not (IsDirectChild $resolvedRoot $resolvedProfile)) {
    throw 'PROFILE_OUTSIDE_SESSION_ROOT'
  }
  $recorded = Get-CimInstance Win32_Process -Filter "ProcessId = $($state.pid)" -ErrorAction SilentlyContinue
  if ($recorded -and -not (ProcessMatchesSession $state)) {
    throw 'SESSION_PROCESS_UNVERIFIED'
  }
  if (AnyBrowserUsingProfile $state) { throw 'BROWSER_STILL_RUNNING' }
  $port = SessionPort $state
  if ($port -and @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue).Count) {
    throw 'CDP_PORT_STILL_LISTENING'
  }
  # Recursive deletion is confined to the exact, script-created child checked above.
  Remove-Item -LiteralPath $resolvedProfile -Recurse -Force
  Remove-Item -LiteralPath (StateFile) -Force
}

function StartSession {
  if ($env:OS -ne 'Windows_NT') { throw 'WINDOWS_REQUIRED' }
  if (Test-Path -LiteralPath (StateFile)) { throw 'SESSION_ALREADY_RECORDED' }
  AssertBrowserPolicy $Browser
  AssertNoReparseAncestors $env:LOCALAPPDATA
  AssertPrivateAcl $env:LOCALAPPDATA
  $executable = FindSignedBrowser $Browser
  $root = SessionRoot
  New-Item -ItemType Directory -Path $root -Force | Out-Null
  if ((Get-Item -LiteralPath $root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'REPARSE_POINT_SESSION_ROOT'
  }
  AssertNoReparseAncestors $root
  AssertPrivateAcl $root
  $profile = Join-Path $root ('session-' + [guid]::NewGuid().ToString('N'))
  if (-not (IsDirectChild $root $profile)) { throw 'PROFILE_OUTSIDE_SESSION_ROOT' }
  New-Item -ItemType Directory -Path $profile | Out-Null
  AssertNoReparseAncestors $profile
  AssertPrivateAcl $profile
  $arguments = LaunchArguments $profile
  # This browser window is intentionally visible for the user's normal QR login.
  $process = Start-Process -FilePath $executable -ArgumentList $arguments -PassThru
  $state = @{ browser = $Browser; executable = $executable; profile = $profile;
    pid = [int]$process.Id; createdUtc = [DateTime]::UtcNow.ToString('o') }
  $state | ConvertTo-Json -Compress | Set-Content -LiteralPath (StateFile) -Encoding UTF8
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    if (-not (ProcessMatchesSession $state)) { throw 'BROWSER_PROCESS_NOT_VERIFIED' }
    $port = SessionPort $state
    if ($port) {
      if ((VerifiedPort $state) -ne $port) { throw 'CDP_PORT_NOT_VERIFIED' }
      return @{ started = $true; browser = $Browser;
        cdp = "http://127.0.0.1:$port/"; profile = 'dedicated_private_session' }
    }
  }
  throw 'CDP_PORT_FILE_TIMEOUT'
}

function StopSession {
  $state = ReadSession
  if (ProcessMatchesSession $state) {
    $process = Get-Process -Id $state.pid -ErrorAction Stop
    if (-not $process.CloseMainWindow()) {
      return @{ stopped = $false; reason = 'close_visible_window_manually_then_retry_stop' }
    }
    try { Wait-Process -Id $state.pid -Timeout 10 -ErrorAction Stop }
    catch { return @{ stopped = $false; reason = 'close_visible_window_manually_then_retry_stop' } }
  }
  CleanupStoppedSession $state
  return @{ stopped = $true; profileRemoved = $true; cdpClosed = $true }
}

function SelfTest {
  $root = Join-Path $env:LOCALAPPDATA 'WeWe-RSS\research-weread-browser'
  $good = Join-Path $root 'session-0123456789abcdef0123456789abcdef'
  $bad = Join-Path $root '..\outside\session-0123456789abcdef0123456789abcdef'
  if (-not (IsDirectChild $root $good) -or (IsDirectChild $root $bad)) { throw 'PATH_TEST_FAILED' }
  $args = LaunchArguments $good
  if ($args.Count -ne 7 -or
    @($args | Where-Object { $_ -match '^--remote-debugging-port=0$' }).Count -ne 1 -or
    @($args | Where-Object { $_ -match '^--remote-debugging-address=127\.0\.0\.1$' }).Count -ne 1 -or
    $args[-1] -ne 'https://weread.qq.com/') { throw 'ARGUMENT_TEST_FAILED' }
  if (-not (IsLoopbackOnly @([pscustomobject]@{ LocalAddress = '127.0.0.1' })) -or
    (IsLoopbackOnly @([pscustomobject]@{ LocalAddress = '0.0.0.0' })) -or
    (IsLoopbackOnly @())) { throw 'LISTENER_TEST_FAILED' }
  return @{ selfTest = 'passed'; assertions = 8; browserLaunches = 0;
    loginPagesOpened = 0; targetRequests = 0; profileWrites = 0 }
}

try {
  switch ($Action) {
    'Plan' {
      $browserPath = FindSignedBrowser $Browser
      AssertBrowserPolicy $Browser
      AssertNoReparseAncestors $env:LOCALAPPDATA
      AssertPrivateAcl $env:LOCALAPPDATA
      $result = @{ readyForOptInStart = [bool]$browserPath; browser = $Browser;
        visibleWindow = $true; dedicatedProfile = $true; dynamicPort = $true;
        requiredBind = '127.0.0.1'; loginPageOpened = $false;
        browserLaunches = 0; targetRequests = 0; userMustCompleteLogin = $true }
    }
    'SelfTest' { $result = SelfTest }
    'Start' { $result = StartSession }
    'Status' {
      $state = ReadSession
      $port = if (ProcessMatchesSession $state) { VerifiedPort $state } else { $null }
      $result = @{ running = [bool]$port; browser = $state.browser;
        cdp = if ($port) { "http://127.0.0.1:$port/" } else { $null };
        loginStatus = 'not_inspected' }
    }
    'Stop' { $result = StopSession }
  }
  $result | ConvertTo-Json -Compress | Write-Output
} catch {
  # No command line, page URL, browser profile path, or CDP body reaches output.
  [Console]::Error.WriteLine('{"stopped":true,"reason":"local_browser_gate_or_process_failure"}')
  exit 1
}
