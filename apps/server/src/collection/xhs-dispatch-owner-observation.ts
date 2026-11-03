import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import type { DispatchOwner } from './xhs-dispatch-owner';
export function observeDispatchOwner(owner: DispatchOwner): 'alive' | 'dead' | 'unknown' {
 if (!owner || typeof owner.nonce !== 'string' || !/^[a-f0-9-]{36}$/.test(owner.nonce) || process.platform !== 'win32' || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || !/^[0-9]{15,20}$/.test(owner.startIdentity)) return 'unknown';
 try {
   const script = '$p=$null;try{$p=[System.Diagnostics.Process]::GetProcessById('+owner.pid+')}catch{if($_.Exception.InnerException -is [System.ArgumentException]){"absent";exit}else{throw}};try{$null=$p.Handle;$p.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)}finally{$p.Dispose()}';
   const value = execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile','-NonInteractive','-Command',script], {encoding:'utf8',timeout:5000,windowsHide:true,maxBuffer:1024}).trim();
   if (value === 'absent') return 'dead';
   if (!/^[0-9]{15,20}$/.test(value)) return 'unknown';
   return value === owner.startIdentity ? 'alive' : 'dead';
 } catch { return 'unknown'; }
}
