import { spawn } from 'node:child_process';
import * as path from 'node:path';

export type XhsSessionCookies = { a1: string; web_session: string };
export interface XhsSessionVault {
  status(): Promise<{ stored: boolean }>;
  store(cookies: XhsSessionCookies): Promise<void>;
  load(): Promise<XhsSessionCookies>;
  disconnect(): Promise<void>;
}
export function checkedXhsCookies(raw: unknown): XhsSessionCookies {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).sort().join(',') !== 'a1,web_session'
  )
    throw Error('XHS_SESSION_INPUT_INVALID');
  const cookies = raw as XhsSessionCookies;
  if (
    Object.values(cookies).some(
      (value) =>
        typeof value !== 'string' ||
        !value ||
        value.length > 8192 ||
        /[;\s\x00-\x1f\x7f]/.test(value),
    )
  )
    throw Error('XHS_SESSION_INPUT_INVALID');
  return { a1: cookies.a1, web_session: cookies.web_session };
}

// Public implementation code only. Secret bytes and the fixed destination are
// sent on stdin, never command arguments/env. This ports the single-note
// CurrentUser DPAPI, exclusive-create, current-user ACL and buffer cleanup design.
const DPAPI_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$plain=$null;$encrypted=$null;$payload=$null;$inputText=$null;$created=$false;$target=$null
try {
  Add-Type -AssemblyName System.Security
  [Console]::InputEncoding=New-Object Text.UTF8Encoding($false)
  [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
  $inputText=[Console]::In.ReadToEnd()
  if([Text.Encoding]::UTF8.GetByteCount($inputText) -gt 24000){throw 'input'}
  $request=$inputText|ConvertFrom-Json
  if(@('status','store','load','disconnect') -notcontains $request.action){throw 'action'}
  $target=[IO.Path]::GetFullPath([string]$request.path)
  if(![IO.Path]::IsPathRooted($target) -or [IO.Path]::GetFileName($target) -cne 'session.dpapi'){throw 'path'}
  $directory=[IO.Path]::GetDirectoryName($target)
  if([IO.Path]::GetFileName($directory) -cne '.wewe-xhs-session'){throw 'path'}
  $parent=$directory
  while($parent){
    if(Test-Path -LiteralPath $parent){if((Get-Item -LiteralPath $parent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'reparse'}}
    $parent=[IO.Path]::GetDirectoryName($parent)
  }
  if(Test-Path -LiteralPath $target){if((Get-Item -LiteralPath $target -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'reparse'}}
  if($request.action -eq 'status'){
    [Console]::Out.Write((@{stored=[bool](Test-Path -LiteralPath $target -PathType Leaf)}|ConvertTo-Json -Compress));exit 0
  }
  if($request.action -eq 'disconnect'){
    if(Test-Path -LiteralPath $target){Remove-Item -LiteralPath $target -Force}
    [Console]::Out.Write('{}');exit 0
  }
  $entropy=[Text.Encoding]::UTF8.GetBytes('WeWe-RSS/xhs-subscription-session/v1')
  if($request.action -eq 'store'){
    if(Test-Path -LiteralPath $target){throw 'exists'}
    $payload=$request.payload
    if($payload.version -ne 1 -or $payload.binding -cne 'xhs-subscription'){throw 'binding'}
    foreach($name in @('a1','web_session')){if(!($payload.cookies.$name -is [string]) -or !$payload.cookies.$name -or $payload.cookies.$name.Length -gt 8192 -or $payload.cookies.$name -match '[;\s\x00-\x1f\x7f]'){throw 'cookies'}}
    [void][IO.Directory]::CreateDirectory($directory)
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl=New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false)
    $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
    $acl.AddAccessRule($rule);[IO.Directory]::SetAccessControl($directory,$acl)
    $plain=[Text.Encoding]::UTF8.GetBytes(($payload|ConvertTo-Json -Depth 5 -Compress))
    $encrypted=[Security.Cryptography.ProtectedData]::Protect($plain,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    $file=[IO.File]::Open($target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);$created=$true
    try {$file.Write($encrypted,0,$encrypted.Length);$file.Flush($true)} finally {$file.Dispose()}
    [Console]::Out.Write('{}')
  } else {
    if(!(Test-Path -LiteralPath $target -PathType Leaf) -or (Get-Item -LiteralPath $target).Length -gt 32768){throw 'missing'}
    $encrypted=[IO.File]::ReadAllBytes($target)
    $plain=[Security.Cryptography.ProtectedData]::Unprotect($encrypted,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    $payload=([Text.Encoding]::UTF8.GetString($plain))|ConvertFrom-Json
    if($payload.version -ne 1 -or $payload.binding -cne 'xhs-subscription'){throw 'binding'}
    foreach($name in @('a1','web_session')){if(!($payload.cookies.$name -is [string]) -or !$payload.cookies.$name -or $payload.cookies.$name.Length -gt 8192 -or $payload.cookies.$name -match '[;\s\x00-\x1f\x7f]'){throw 'cookies'}}
    [Console]::Out.Write((@{a1=$payload.cookies.a1;web_session=$payload.cookies.web_session}|ConvertTo-Json -Compress))
  }
} catch {
  if($created -and $target -and (Test-Path -LiteralPath $target)){Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue}
  [Console]::Error.Write(('XHS_VAULT_OPERATION_FAILED_LINE_'+$_.InvocationInfo.ScriptLineNumber+'_'+$_.Exception.GetType().Name));exit 1
} finally {
  if($plain){[Array]::Clear($plain,0,$plain.Length)}
  if($encrypted){[Array]::Clear($encrypted,0,$encrypted.Length)}
  if($payload -and $payload.cookies){$payload.cookies.a1='';$payload.cookies.web_session=''}
  $inputText=$null;$request=$null;$payload=$null
}
`;
export type XhsVaultAction = 'status' | 'store' | 'load' | 'disconnect';
export type XhsVaultCall = (
  action: XhsVaultAction,
  file: string,
  cookies?: XhsSessionCookies,
) => Promise<unknown>;
export const callWindowsDpapi: XhsVaultCall = (action, file, cookies) => {
  if (process.platform !== 'win32')
    return Promise.reject(Error('XHS_VAULT_WINDOWS_REQUIRED'));
  const bytes = Buffer.from(
    JSON.stringify({
      action,
      path: file,
      ...(cookies
        ? { payload: { version: 1, binding: 'xhs-subscription', cookies } }
        : {}),
    }),
  );
  if (bytes.length > 24000) {
    bytes.fill(0);
    return Promise.reject(Error('XHS_VAULT_INPUT_INVALID'));
  }
  return new Promise((resolve, reject) => {
    const executable = path.join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    const child = spawn(
      executable,
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(DPAPI_SCRIPT, 'utf16le').toString('base64'),
      ],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const chunks: Buffer[] = [];
    let size = 0,
      failed = false,
      diagnostic = 'XHS_VAULT_OPERATION_FAILED';
    const timer = setTimeout(() => {
      diagnostic = 'XHS_VAULT_OPERATION_FAILED_TIMEOUT';
      failed = true;
      child.kill();
    }, 15000);
    timer.unref?.();
    child.stdout.on('data', (part: Buffer) => {
      size += part.length;
      if (size > 24000) {
        failed = true;
        part.fill(0);
        child.kill();
      } else chunks.push(part);
    });
    child.stderr.on('data', (part: Buffer) => {
      failed = true;
      const code = part.toString('utf8');
      if (
        diagnostic !== 'XHS_VAULT_OPERATION_FAILED_TIMEOUT' &&
        /^XHS_VAULT_OPERATION_FAILED_LINE_\d+_[A-Za-z]{1,80}$/.test(code)
      )
        diagnostic = code;
      part.fill(0);
    });
    child.on('error', () => {
      failed = true;
    });
    child.stdin.on('error', () => {
      failed = true;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let combined: Buffer | undefined;
      try {
        if (failed || code !== 0) throw Error();
        combined = Buffer.concat(chunks);
        resolve(JSON.parse(combined.toString('utf8')));
      } catch {
        reject(Error(diagnostic));
      } finally {
        bytes.fill(0);
        combined?.fill(0);
        chunks.forEach((part) => part.fill(0));
      }
    });
    child.stdin.end(bytes, () => bytes.fill(0));
  });
};
export class XhsDpapiSessionVault implements XhsSessionVault {
  private readonly file: string;
  constructor(
    dataDirectory: string,
    private readonly call: XhsVaultCall = callWindowsDpapi,
  ) {
    if (!path.isAbsolute(dataDirectory))
      throw Error('XHS_VAULT_DIRECTORY_INVALID');
    this.file = path.join(dataDirectory, '.wewe-xhs-session', 'session.dpapi');
  }
  async status() {
    const result = (await this.call('status', this.file)) as {
      stored?: unknown;
    };
    if (typeof result.stored !== 'boolean')
      throw Error('XHS_VAULT_OPERATION_FAILED');
    return { stored: result.stored };
  }
  async store(cookies: XhsSessionCookies) {
    const next = checkedXhsCookies(cookies);
    try {
      await this.call('store', this.file, next);
    } finally {
      next.a1 = '';
      next.web_session = '';
    }
  }
  async load() {
    const raw = await this.call('load', this.file);
    try {
      return checkedXhsCookies(raw);
    } finally {
      if (raw && typeof raw === 'object') {
        (raw as XhsSessionCookies).a1 = '';
        (raw as XhsSessionCookies).web_session = '';
      }
    }
  }
  async disconnect() {
    await this.call('disconnect', this.file);
  }
}
