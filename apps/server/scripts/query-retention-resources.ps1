param(
  [Parameter(Mandatory=$true)][string]$Batch,
  [Parameter(Mandatory=$true)][string]$Output
)
# Read-only Windows resource queries. No shutdown, restart or deletion API.
$ErrorActionPreference='Stop'
if ((Get-Item -LiteralPath $Batch).Length -gt 262144) { throw 'Batch byte limit' }
$plan=Get-Content -LiteralPath $Batch -Raw -Encoding utf8 | ConvertFrom-Json
if ($plan.payload.format -ne 'sqlite-retention-review-v1' -or $plan.digest -notmatch '^[a-f0-9]{64}$') { throw 'Invalid batch' }
if (@($plan.payload.candidates).Count -gt 128) { throw 'Candidate limit' }
$files=@(@($plan.payload.candidates | ForEach-Object {$_.path})+@($plan.payload.candidates | Where-Object representative | ForEach-Object {$_.representative}) | Select-Object -Unique)
foreach ($file in $files) {
  if (![IO.Path]::IsPathFullyQualified($file) -or $file.StartsWith('\\') -or $file.StartsWith('//') -or $file -match '[\x00\r\n]') { throw 'Invalid local path' }
}
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class RetentionResourceQuery {
  [StructLayout(LayoutKind.Sequential)] public struct UniqueProcess { public int pid; public System.Runtime.InteropServices.ComTypes.FILETIME start; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct ProcessInfo {
    public UniqueProcess process;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=256)] public string application;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=64)] public string service;
    public uint type, status, session;
    [MarshalAs(UnmanagedType.Bool)] public bool restartable;
  }
  [DllImport("rstrtmgr.dll",CharSet=CharSet.Unicode)] static extern int RmStartSession(out uint handle,uint flags,StringBuilder key);
  [DllImport("rstrtmgr.dll",CharSet=CharSet.Unicode)] static extern int RmRegisterResources(uint handle,uint files,string[] names,uint applications,IntPtr app,uint services,IntPtr service);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint handle,out uint needed,ref uint count,[In,Out] ProcessInfo[] list,ref uint reasons);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint handle);
  public static int[] Query(string file) {
    uint handle; int code=RmStartSession(out handle,0,new StringBuilder(33));
    if(code!=0) throw new Exception("Resource query failed");
    try {
      code=RmRegisterResources(handle,1,new[]{file},0,IntPtr.Zero,0,IntPtr.Zero);
      if(code!=0) throw new Exception("Resource registration failed");
      uint needed,count=0,reasons=0;
      code=RmGetList(handle,out needed,ref count,null,ref reasons);
      if(code==0 && needed==0) return new int[0];
      if(code!=234 || needed>4096) throw new Exception("Resource list unproved");
      count=needed;var list=new ProcessInfo[needed];
      code=RmGetList(handle,out needed,ref count,list,ref reasons);
      if(code!=0) throw new Exception("Resource list changed");
      var result=new int[count];
      for(int i=0;i<count;i++) result[i]=list[i].process.pid;
      return result;
    } finally { RmEndSession(handle); }
  }
}
'@
# Use start time, so even the earliest query must still be fresh at validation.
$checkedAt=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$results=@()
foreach ($file in $files) {
  if ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()-$checkedAt -gt 30) { throw 'Resource query deadline' }
  try { $users=@([RetentionResourceQuery]::Query($file));$results+=@{path=$file;querySucceeded=$true;users=$users} }
  catch { $results+=@{path=$file;querySucceeded=$false;users=@();error='RESOURCE_QUERY_FAILED'} }
}
$encoded=[Text.UTF8Encoding]::new($false).GetBytes((@{batchId=$plan.batchId;digest=$plan.digest;checkedAtEpoch=$checkedAt;files=$results} | ConvertTo-Json -Depth 8 -Compress))
if ($encoded.Length -gt 262144) { throw 'Report byte limit' }
$stream=[IO.File]::Open([IO.Path]::GetFullPath($Output),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try { $stream.Write($encoded,0,$encoded.Length) } finally { $stream.Dispose() }
@{files=$results.Count;failedQueries=@($results | Where-Object {$_.querySucceeded -ne $true}).Count;occupiedFiles=@($results | Where-Object {$_.users.Count -gt 0}).Count;deletionPerformed=$false} | ConvertTo-Json -Compress
