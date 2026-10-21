# Read-only application-scoped observation. Null unrelated system properties are
# reported as unknown, not exempted or fabricated. Never grants cleanup authority.
param([Parameter(Mandatory)][string]$Installation,[Parameter(Mandatory)][string]$Database)
$ErrorActionPreference='Stop'
$observed=@(Get-CimInstance Win32_Process -OperationTimeoutSec 10 | Select-Object -First 4097 -Property ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine)
if($observed.Count -gt 4096) { throw 'FRONTEND_WRITER_ENTRY_LIMIT' }
$logicalDisks=@(Get-CimInstance Win32_LogicalDisk -OperationTimeoutSec 10 | Select-Object -First 33 -Property DeviceID,DriveType,ProviderName)
if($logicalDisks.Count -gt 32) { throw 'FRONTEND_LOGICAL_DISK_LIMIT' }
# Raw fields stay in the controller's private memory. The controller classifies
# relevant conflicts and records only unknown IDs for unrelated null properties.
$result=[ordered]@{querySucceeded=$true;collectorPid=$PID;processes=$observed;logicalDisks=$logicalDisks;globalComplete=$false}|ConvertTo-Json -Compress -Depth 4
if([Text.Encoding]::UTF8.GetByteCount($result) -gt 4194304) { throw 'FRONTEND_WRITER_OUTPUT_LIMIT' }
$result
