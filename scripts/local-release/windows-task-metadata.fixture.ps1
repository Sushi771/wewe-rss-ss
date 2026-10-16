param([string]$Source)
# Owned data-only boundaries; no actual task/COM/registry/process query.
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'source syntax'}
foreach($name in @('Budget','Expand-ReferenceText','Task-Digest','Tasks')) {
  $node=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
  if($null -eq $node){throw 'missing production function'}
  . ([scriptblock]::Create($node.Extent.Text))
}
$deadline=[DateTime]::UtcNow.AddSeconds(16)
$global:OwnedData='original input';$global:OwnedClass='{12345678-1234-1234-1234-123456789abc}'
function Get-ScheduledTask {
  [PSCustomObject]@{TaskPath='\Owned\';TaskName='Metadata';Actions=@(
    [PSCustomObject]@{CimClass=[PSCustomObject]@{CimClassName='MSFT_TaskComHandlerAction'};ClassId=$global:OwnedClass;Data=$global:OwnedData;Id='owned-com'},
    [PSCustomObject]@{CimClass=[PSCustomObject]@{CimClassName='MSFT_TaskExecAction'};Execute='C:\owned\never-executed.exe';Arguments='--inert';WorkingDirectory='';Id='owned-exec'}
  )}
}
function Get-CimInstance {throw 'real CIM boundary forbidden'}
function Get-ItemProperty {throw 'registry boundary forbidden'}
$first=@(Tasks);$stable=@(Tasks)
if((ConvertTo-Json -InputObject $first -Depth 8 -Compress) -cne (ConvertTo-Json -InputObject $stable -Depth 8 -Compress)){throw 'unstable metadata'}
$global:OwnedData='changed input';$data=@(Tasks)
$global:OwnedClass='{aaaaaaaa-1234-1234-1234-123456789abc}';$class=@(Tasks)
$global:OwnedData='x'*32769;$limited=$false
try {$null=@(Tasks)}catch {$limited=$_.Exception.Message -eq 'REFERENCE_NATIVE_TASK_METADATA_LIMIT'}
@{first=$first;data=$data;class=$class;oversizeRefused=$limited;nativeQueries=0} | ConvertTo-Json -Depth 10 -Compress
