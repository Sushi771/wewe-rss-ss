import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
export type DispatchOwner = { pid: number; startIdentity: string; nonce: string };
export function readSelfStartIdentity(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  try {
    const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const script = '$p=[System.Diagnostics.Process]::GetProcessById(' + process.pid + ');try{$null=$p.Handle;$p.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)}finally{$p.Dispose()}';
    const result = execFileSync(exe, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 1024 }).trim();
    return /^[0-9]{15,20}$/.test(result) ? result : undefined;
  } catch { return undefined; }
}
export function createDispatchOwner(): DispatchOwner | undefined {
  const startIdentity = readSelfStartIdentity();
  return startIdentity ? { pid: process.pid, startIdentity, nonce: randomUUID() } : undefined;
}
export function ownsDispatch(value: unknown, expected: DispatchOwner | undefined): value is DispatchOwner {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<DispatchOwner>;
  return !!expected && v.pid === expected.pid && v.startIdentity === expected.startIdentity && v.nonce === expected.nonce && v.pid === process.pid && typeof v.nonce === 'string' && /^[a-f0-9-]{36}$/.test(v.nonce) && typeof v.startIdentity === 'string' && v.startIdentity === readSelfStartIdentity();
}
