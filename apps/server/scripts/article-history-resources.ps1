# Query only: no stop/shutdown/restart/delete methods are declared.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$raw = [Console]::In.ReadToEnd()
if ($raw.Length -gt 32768) { throw 'RESOURCE_INPUT_LIMIT' }
$parsed = ConvertFrom-Json -InputObject $raw
$files = @()
foreach ($entry in $parsed) { $files += [string]$entry }
if ($files.Count -lt 1 -or $files.Count -gt 32) { throw 'RESOURCE_COUNT_LIMIT' }
foreach ($file in $files) {
  if (![IO.Path]::IsPathRooted($file) -or $file.StartsWith('\\') -or $file -match '[\x00\r\n]') { throw 'RESOURCE_PATH_INVALID' }
}
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class HistoryResourceQuery {
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
    if(code!=0) throw new Exception("RESOURCE_QUERY_FAILED");
    try {
      code=RmRegisterResources(handle,1,new[]{file},0,IntPtr.Zero,0,IntPtr.Zero);
      if(code!=0) throw new Exception("RESOURCE_REGISTER_FAILED");
      uint needed,count=0,reasons=0;
      code=RmGetList(handle,out needed,ref count,null,ref reasons);
      if(code==0 && needed==0) return new int[0];
      if(code!=234 || needed>4096) throw new Exception("RESOURCE_LIST_UNPROVED");
      count=needed;var list=new ProcessInfo[needed];
      code=RmGetList(handle,out needed,ref count,list,ref reasons);
      if(code!=0) throw new Exception("RESOURCE_LIST_CHANGED");
      var result=new int[count];
      for(int i=0;i<count;i++) result[i]=list[i].process.pid;
      return result;
    } finally { RmEndSession(handle); }
  }
}
'@
$started = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$rows = @()
foreach ($file in $files) {
  if ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - $started -gt 30) { throw 'RESOURCE_DEADLINE' }
  $users = @([HistoryResourceQuery]::Query($file))
  $rows += @{path=[string]$file;users=$users}
}
@{querySucceeded=$true;checkedAtEpoch=$started;files=$rows} | ConvertTo-Json -Depth 6 -Compress
