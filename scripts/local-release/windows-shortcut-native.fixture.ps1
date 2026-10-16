param([string]$Source,[string]$OwnedDirectory)
# Real hash/COM operations on a newly-created inert Unicode shortcut only.
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'source syntax'}
foreach($name in @('Reference-Stage','Reference-Failure','Budget','Expand-ReferenceText','Shortcut-Sha256','Read-Shortcut')) {
  $node=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
  if($null -eq $node){throw 'missing production function'}
  . ([scriptblock]::Create($node.Extent.Text))
}
$global:HashCmdletCalls=0
function Get-FileHash {$global:HashCmdletCalls++;throw [Management.Automation.CommandNotFoundException]::new('Unavailable optional command')}
$file=[IO.Path]::Combine($OwnedDirectory,([char]0x6D4B)+'-owned.lnk')
$target=[IO.Path]::Combine($OwnedDirectory,'inert-target.exe')
[IO.File]::WriteAllText($target,'inert owned target; never executed')
$shell=New-Object -ComObject WScript.Shell
try {
  # WSH Save is locale-sensitive on hosted runners. Construct an ASCII-named
  # fixture, then rename with Unicode IO; production still reads the Unicode path.
  $ascii=[IO.Path]::Combine($OwnedDirectory,'ascii-owned.lnk')
  $link=$shell.CreateShortcut($ascii);$link.TargetPath=$target;$link.WorkingDirectory=$OwnedDirectory;$link.Save()
  [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($link)
  [IO.File]::Move($ascii,$file)
  $deadline=[DateTime]::UtcNow.AddSeconds(16)
  $diagnosticContext=[PSCustomObject]@{stage='unit';folderKind='Startup';failure=$null}
  $seen=[System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $shortcuts=[System.Collections.Generic.List[object]]::new()
  Read-Shortcut (Get-Item -LiteralPath $file -Force) $shell
  if($shortcuts.Count -ne 1){throw 'missing real COM record'}
  $normal=$shortcuts[0]
  $seen.Clear();$shortcuts.Clear()
  $exclusive=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  $refused=$false
  try {Read-Shortcut (Get-Item -LiteralPath $file -Force) $shell}
  catch {Reference-Failure $_;$refused=$true}
  finally {$exclusive.Dispose()}
  if(-not $refused -or $shortcuts.Count -ne 0){throw 'sharing failure accepted'}
  @{normal=$normal;hashCmdletCalls=$global:HashCmdletCalls;sharingRefused=$refused;failureContext=$diagnosticContext.failure} | ConvertTo-Json -Depth 8 -Compress
} finally {[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)}
