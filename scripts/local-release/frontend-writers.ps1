# Read-only application-scoped observation. Null unrelated system properties are
# reported as unknown, not exempted or fabricated. Never grants cleanup authority.
param([Parameter(Mandatory)][string]$Installation,[Parameter(Mandatory)][string]$Database)
$ErrorActionPreference='Stop'
$observed=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath,CommandLine)
# Raw fields stay in the controller's private memory. The controller classifies
# relevant conflicts and records only unknown IDs for unrelated null properties.
[ordered]@{querySucceeded=$true;collectorPid=$PID;processes=$observed;globalComplete=$false}|ConvertTo-Json -Compress -Depth 4
