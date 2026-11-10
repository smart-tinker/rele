import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

/** These handles come from our transport, never from server/diagnostics. */
export type CodexNativePeer = { kind: 'stdio'; pid: number; codexHome?: string; executable?: string; helperExecutable?: string } | { kind: 'proxy'; pid: number; endpoint: string }
  | { kind: 'windows-shared'; endpoint: string; localPort: number; remotePort: number };

// Read only the owned child/connected Unix peer. No native control commands or signals.
const LINUX_PROOF = String.raw`
import hashlib, json, os, re, socket, stat, struct, subprocess, sys

def require(value):
    if not value: raise ValueError('unproven')

def read(file, limit=65536):
    with open(file, 'rb') as stream:
        value=stream.read(limit+1)
        require(len(value)<=limit)
        return value

def identity(pid):
    root='/proc/'+str(pid)
    before=read(root+'/stat').rsplit(b')',1)[1].split()
    uid=os.stat(root).st_uid
    require(uid==os.getuid())
    executable=os.readlink(root+'/exe')
    require(os.path.isabs(executable))
    h=hashlib.sha256()
    with open(root+'/exe','rb') as stream:
        before_exe=os.fstat(stream.fileno())
        for block in iter(lambda:stream.read(1024*1024),b''): h.update(block)
        after_exe=os.fstat(stream.fileno())
        require(all(getattr(after_exe,key)==getattr(before_exe,key) for key in ('st_dev','st_ino','st_size','st_mtime_ns')))
    after=read(root+'/stat').rsplit(b')',1)[1].split()
    require(before[19]==after[19] and before[1]==after[1])
    return dict(pid=pid,birth=before[19].decode(),owner=str(uid),executable=executable,sha256=h.hexdigest())

def profile(pid):
    env=read('/proc/'+str(pid)+'/environ',1024*1024).split(b'\0')
    def value(key):
        values=[entry[len(key)+1:].decode() for entry in env if entry.startswith(key+b'=')]
        require(len(values)<=1)
        return values[0] if values else None
    selected=value(b'CODEX_HOME') or os.path.join(value(b'HOME') or '', '.codex')
    require(os.path.isabs(selected))
    return os.path.realpath(selected)

def sockets(pid):
    result=set()
    for entry in os.scandir('/proc/'+str(pid)+'/fd'):
        try: match=re.fullmatch(r'socket:\[(\d+)\]',os.readlink(entry.path))
        except FileNotFoundError: continue
        if match: result.add(int(match[1]))
    return result

def unix_peers():
    # Linux unix_diag_req / UNIX_DIAG_PEER: query kernel socket peers, not pathname coincidence.
    with socket.socket(socket.AF_NETLINK,socket.SOCK_RAW,4) as netlink:
        netlink.settimeout(2)
        request=struct.pack('=BBHIIIII',socket.AF_UNIX,0,0,0xffffffff,0,5,0xffffffff,0xffffffff)
        netlink.send(struct.pack('=IHHII',16+len(request),20,0x301,1,0)+request)
        result={}
        while True:
            raw,address=netlink.recvfrom(1024*1024)
            require(address[0]==0)
            offset=0
            while offset+16<=len(raw):
                length,kind,flags,sequence,pid=struct.unpack_from('=IHHII',raw,offset)
                require(length>=16 and offset+length<=len(raw) and sequence==1)
                message=raw[offset+16:offset+length]
                if kind==3:
                    require(not flags & 0x10) # interrupted dump is not complete evidence
                    return result
                require(kind==20 and len(message)>=16)
                family,typ,state,pad,inode,cookie1,cookie2=struct.unpack_from('=BBBBIII',message)
                require(family==socket.AF_UNIX)
                attributes={}
                cursor=16
                while cursor+4<=len(message):
                    size,key=struct.unpack_from('=HH',message,cursor)
                    require(size>=4 and cursor+size<=len(message) and key not in attributes)
                    attributes[key]=message[cursor+4:cursor+size]
                    cursor+=(size+3)&~3
                peer=attributes.get(2)
                result[inode]=(state,struct.unpack('=I',peer)[0] if peer and len(peer)==4 else None,attributes.get(0,b'').rstrip(b'\0').decode())
                offset+=(length+3)&~3

def pid_records(home):
    records=[]
    for name in ('daemon.pid','app-server.pid'):
        file=os.path.join(home,'app-server-daemon',name)
        try: info=os.lstat(file)
        except FileNotFoundError: continue
        require(stat.S_ISREG(info.st_mode) and info.st_uid==os.getuid() and info.st_size<=16384)
        raw=read(file,16384)
        fields=('st_dev','st_ino','st_uid','st_gid','st_mode','st_size','st_mtime_ns','st_ctime_ns')
        records.append((file,raw,json.loads(raw),tuple(getattr(info,key) for key in fields)))
    return records

def endpoint_identity(endpoint):
    published=os.lstat(endpoint)
    require(published.st_uid==os.getuid() and (stat.S_ISSOCK(published.st_mode) or stat.S_ISLNK(published.st_mode)))
    canonical=os.path.realpath(endpoint)
    target=os.lstat(canonical)
    require(stat.S_ISSOCK(target.st_mode) and target.st_uid==os.getuid())
    fields=('st_dev','st_ino','st_uid','st_gid','st_mode','st_size','st_mtime_ns','st_ctime_ns')
    return canonical,(tuple(getattr(published,key) for key in fields),
        os.readlink(endpoint) if stat.S_ISLNK(published.st_mode) else None,
        tuple(getattr(target,key) for key in fields))

try:
    kind,peer_pid,server_pid,home,endpoint=sys.argv[1:]
    peer_pid,server_pid=int(peer_pid),int(server_pid)
    require(kind in ('stdio','proxy') and peer_pid>1 and server_pid>1 and os.path.isabs(home))
    home=os.path.realpath(home)
    require(stat.S_ISDIR(os.stat(home).st_mode) and os.stat(home).st_uid==os.getuid())
    records=pid_records(home) if kind=='proxy' else []
    boot=read('/proc/sys/kernel/random/boot_id').decode().strip()
    require(re.fullmatch('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',boot))
    before=identity(server_pid)
    require(profile(server_pid)==home)
    peer_before=read('/proc/'+str(peer_pid)+'/stat').rsplit(b')',1)[1].split()
    require(int(peer_before[1])==os.getppid() and os.stat('/proc/'+str(peer_pid)).st_uid==os.getuid())
    if kind=='stdio': require(peer_pid==server_pid)
    else:
        require(endpoint==os.path.join(home,'app-server-control','app-server-control.sock'))
        bound,endpoint_before=endpoint_identity(endpoint)
        native_sockets,proxy_sockets=sockets(server_pid),sockets(peer_pid)
        rows=unix_peers()
        listeners=[inode for inode in native_sockets if inode in rows and rows[inode][0]==10 and rows[inode][2]==bound]
        require(len(listeners)==1)
        matches=[inode for inode in proxy_sockets if inode in rows and rows[inode][1] in native_sockets and rows[rows[inode][1]][1]==inode and rows[rows[inode][1]][2]==bound]
        require(len(matches)==1)
        # Legacy retained daemons may have no pid-record. Existing records are
        # strict corroboration; kernel transport and physical proof remain required.
        require(len(records)<=1)
        if records:
            require(records[0][2].get('pid')==server_pid)
            birth=subprocess.check_output(['/usr/bin/ps','-p',str(server_pid),'-o','lstart='],timeout=2).decode().strip()
            require(records[0][2].get('processStartTime')==birth)
        require(endpoint_identity(endpoint)==(bound,endpoint_before))
        selected={listeners[0],matches[0],rows[matches[0]][1]}
        require(matches[0] in sockets(peer_pid) and {listeners[0],rows[matches[0]][1]} <= sockets(server_pid))
        # Only this listener and reciprocal transport pair matter; other native
        # sockets can change while a model connection or another client is active.
        after_rows=unix_peers()
        require(all(after_rows.get(inode)==rows[inode] for inode in selected))
    require(identity(server_pid)==before and profile(server_pid)==home)
    require(read('/proc/'+str(peer_pid)+'/stat').rsplit(b')',1)[1].split()[19]==peer_before[19])
    require(read('/proc/sys/kernel/random/boot_id').decode().strip()==boot)
    if kind=='proxy': require(pid_records(home)==records)
    print(json.dumps(dict(before,boot=boot,codexHome=home)))
except Exception:
    sys.exit(1)
`;

// Shared status attests the installed owner/profile. Stdio instead uses only our
// spawned child (or the exact installed Job Object helper and its direct child).
const WINDOWS_PROOF = String.raw`
$ErrorActionPreference='Stop'
$script:stage='input'
try {
  $inputProof=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__INPUT__')))
  $r=$inputProof.receipt; $p=$inputProof.peer; $stdio=$p.kind -eq 'stdio'
  function Require($ok) { if (-not $ok) { throw 'unproven' } }
  Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
using System.Text;
public static class RelePath {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern uint GetLongPathName(string shortPath, StringBuilder longPath, uint bufferLength);
}
'@
  function CanonicalPath($value) {
    $buffer=New-Object Text.StringBuilder 32768
    $length=[RelePath]::GetLongPathName($value,$buffer,[uint32]$buffer.Capacity)
    if ($length -le 0 -or $length -ge $buffer.Capacity) { return $null }
    return [IO.Path]::GetFullPath($buffer.ToString())
  }
  function SameFilePath($left,$right) {
    $a=CanonicalPath $left; $b=CanonicalPath $right
    return ($null -ne $a -and $null -ne $b -and $a -ieq $b)
  }
  function Identity {
    $script:stage='process-query'
    $native=[Diagnostics.Process]::GetProcessById([int]$inputProof.serverId); $helper=$null
    try {
      $script:stage='process-handle'
      Require ($native.Handle -ne [IntPtr]::Zero)
      $script:stage='owner-query'
      $record=Get-CimInstance Win32_Process -Filter ("ProcessId="+$native.Id) -ErrorAction Stop
      $owner=Invoke-CimMethod -InputObject $record -MethodName GetOwnerSid -ErrorAction Stop
      Require ($owner.ReturnValue -eq 0)
      $script:stage='image-query'
      $exe=$native.MainModule.FileName; $birth=$native.StartTime.ToUniversalTime().ToString('o')
      $hash=(Get-FileHash -LiteralPath $exe -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
      $script:stage='process-identity'
      if ($stdio) {
        $gatewayOwner=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $executableMatchesExpected=SameFilePath $exe $p.executable
        Require ($owner.Sid -eq $gatewayOwner)
        $expectedParent=$inputProof.gatewayId
        if ($p.helperExecutable) { $expectedParent=$p.pid } else { Require ($native.Id -eq $p.pid) }
        Require ($record.ParentProcessId -eq $expectedParent)
        $nativeHome=[IO.Path]::GetFullPath($p.codexHome)
        Require ([IO.Directory]::Exists($nativeHome))
      } else {
        $executableMatchesExpected=SameFilePath $exe $r.executable
        Require ($owner.Sid -eq $r.ownerSid -and $birth -ceq $r.processStartTime -and $hash -ceq $r.executableSha256)
        $nativeHome=[IO.Path]::GetFullPath($r.codexHome)
      }
      $script:stage='boot-query'
      $boot=(Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime().ToString('o')
      $result=[ordered]@{pid=$native.Id;birth=$birth;boot=$boot;executable=[IO.Path]::GetFullPath($exe).ToLowerInvariant();sha256=$hash;owner=$owner.Sid;codexHome=$nativeHome.ToLowerInvariant()}
      $result.executableMatchesExpected=$executableMatchesExpected
      if ($stdio) {
        $result.parentPid=[int]$record.ParentProcessId; $result.gatewayOwner=$gatewayOwner
        if ($p.helperExecutable) {
          $helper=[Diagnostics.Process]::GetProcessById([int]$p.pid)
          Require ($helper.Handle -ne [IntPtr]::Zero)
          $helperRecord=Get-CimInstance Win32_Process -Filter ("ProcessId="+$helper.Id) -ErrorAction Stop
          $helperOwner=Invoke-CimMethod -InputObject $helperRecord -MethodName GetOwnerSid -ErrorAction Stop
          $helperExecutableMatchesExpected=SameFilePath $helper.MainModule.FileName $p.helperExecutable
          Require ($helperRecord.ParentProcessId -eq $inputProof.gatewayId -and $helperOwner.ReturnValue -eq 0 -and $helperOwner.Sid -eq $gatewayOwner)
          $result.helperPid=$helper.Id; $result.helperParentPid=[int]$helperRecord.ParentProcessId; $result.helperExecutable=[IO.Path]::GetFullPath($helper.MainModule.FileName).ToLowerInvariant()
          $result.helperExecutableMatchesExpected=$helperExecutableMatchesExpected
          $result.helperBirth=$helper.StartTime.ToUniversalTime().ToString('o'); $result.helperOwner=$helperOwner.Sid
          $result.helperSha256=(Get-FileHash -LiteralPath $helper.MainModule.FileName -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
        }
      }
      return $result
    } finally { if ($helper) { $helper.Dispose() }; $native.Dispose() }
  }
  function Peer {
    if ($stdio) { return }
    $script:stage='tcp-query'
    $rows=@(Get-NetTCPConnection -State Established -ErrorAction Stop)
    $script:stage='tcp-match'
    $server=@($rows | Where-Object { $_.LocalAddress -eq '127.0.0.1' -and $_.LocalPort -eq $p.remotePort -and $_.RemoteAddress -eq '127.0.0.1' -and $_.RemotePort -eq $p.localPort })
    $client=@($rows | Where-Object { $_.LocalAddress -eq '127.0.0.1' -and $_.LocalPort -eq $p.localPort -and $_.RemoteAddress -eq '127.0.0.1' -and $_.RemotePort -eq $p.remotePort })
    Require ($server.Count -eq 1 -and $server[0].OwningProcess -eq $r.processId -and $client.Count -eq 1 -and $client[0].OwningProcess -eq $inputProof.gatewayId)
  }
  $script:stage='peer-before'
  Peer
  $script:stage='identity-before'
  $before=Identity
  $script:stage='peer-after'
  Peer
  $script:stage='identity-after'
  $after=Identity
  $script:stage='identity-compare'
  Require (($before | ConvertTo-Json -Compress) -ceq ($after | ConvertTo-Json -Compress))
  $before.peerVerified=$true; $before.gatewayId=$inputProof.gatewayId
  if (-not $stdio) { $before.localPort=$p.localPort; $before.remotePort=$p.remotePort }
  $script:stage='proof-output'
  $before | ConvertTo-Json -Compress
  $script:stage='complete'
} catch { [Console]::Error.WriteLine('rele-native-proof:' + $script:stage); exit 1 }
`;

interface CommandResult { stdout: string; code: number | null }
export interface CodexNativeGenerationOptions {
  platform?: NodeJS.Platform;
  run?: (command: string, args: string[]) => Promise<CommandResult>;
  installationDirectory?: string;
}

const execute = promisify(execFile);
const SHA = /^[a-f0-9]{64}$/u;
const WINDOWS_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/u;
function windowsPath(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z]:\\/u.test(value) && path.win32.isAbsolute(value); }
function sameWindowsPath(left: string, right: string): boolean {
  if (path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase()) return true;
  try {
    const a = statSync(left, { bigint:true }), b = statSync(right, { bigint:true });
    if (a.dev !== 0n && b.dev !== 0n && a.ino !== 0n && b.ino !== 0n) return a.dev === b.dev && a.ino === b.ino;
    return path.win32.normalize(realpathSync.native(left)).toLowerCase() === path.win32.normalize(realpathSync.native(right)).toLowerCase();
  } catch { return false; }
}
async function windowsGeneration(peer: Exclude<CodexNativePeer, { kind: 'proxy' }>, serverId: number, home: string, options: CodexNativeGenerationOptions): Promise<string | undefined> {
  if (!windowsPath(home)) return;
  const run = options.run ?? (async (command: string, args: string[]) => ({ ...(await execute(command, args, { timeout: 30_000, maxBuffer: 128 * 1024, windowsHide: true })), code: 0 }));
  const directory = options.installationDirectory ?? fileURLToPath(new URL('../../', import.meta.url));
  let receipt: any;
  if (peer.kind === 'stdio') {
    if (!Number.isSafeInteger(peer.pid) || peer.pid <= 1 || !windowsPath(peer.executable) || !windowsPath(peer.codexHome) || !sameWindowsPath(peer.codexHome, home)) return;
    if (peer.helperExecutable) {
      if (peer.pid === serverId || !sameWindowsPath(peer.helperExecutable, path.win32.join(directory, 'dist', 'native', 'Rele.Process.exe'))) return;
    } else if (peer.pid !== serverId) return;
  } else {
    if (!Number.isInteger(peer.localPort) || peer.localPort <= 0 || peer.localPort > 65535
      || !Number.isInteger(peer.remotePort) || peer.remotePort <= 0 || peer.remotePort > 65535
      || peer.localPort === peer.remotePort || peer.endpoint !== `ws://127.0.0.1:${peer.remotePort}`) return;
    const status = await run(path.win32.join(directory, 'Rele.exe'), ['codex-status', '--quiet', '--codex-home', home]);
    receipt = JSON.parse(status.stdout);
    if (status.code !== 0 || receipt?.status !== 'alreadyRunning' || receipt.endpoint !== peer.endpoint || receipt.processId !== serverId
      || !windowsPath(receipt.codexHome) || !sameWindowsPath(receipt.codexHome, home) || !windowsPath(receipt.executable)
      || !SHA.test(receipt.executableSha256) || typeof receipt.ownerSid !== 'string' || !/^S-1-\d+(?:-\d+)+$/u.test(receipt.ownerSid)
      || typeof receipt.processStartTime !== 'string' || !WINDOWS_TIME.test(receipt.processStartTime) || !Number.isFinite(Date.parse(receipt.processStartTime))) return;
  }
  const input = Buffer.from(JSON.stringify({ receipt, peer, serverId, gatewayId: process.pid })).toString('base64');
  const source = WINDOWS_PROOF.replace('__INPUT__', input);
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const result = await run(path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')]);
  const proof = JSON.parse(result.stdout);
  if (result.code !== 0 || proof?.peerVerified !== true || proof.pid !== serverId || proof.gatewayId !== process.pid
    || typeof proof.birth !== 'string' || !WINDOWS_TIME.test(proof.birth) || !Number.isFinite(Date.parse(proof.birth))
    || typeof proof.owner !== 'string' || !/^S-1-\d+(?:-\d+)+$/u.test(proof.owner) || !SHA.test(proof.sha256)
    || !windowsPath(proof.executable) || !windowsPath(proof.codexHome) || !sameWindowsPath(proof.codexHome, home)
    || typeof proof.boot !== 'string' || !WINDOWS_TIME.test(proof.boot) || !Number.isFinite(Date.parse(proof.boot))) return;
  if (peer.kind === 'stdio') {
    if (proof.parentPid !== (peer.helperExecutable ? peer.pid : process.pid) || proof.gatewayOwner !== proof.owner
      || (proof.executableMatchesExpected !== true && !sameWindowsPath(proof.executable, peer.executable!))) return;
    if (peer.helperExecutable && (proof.helperPid !== peer.pid || proof.helperParentPid !== process.pid || proof.helperOwner !== proof.owner
      || !windowsPath(proof.helperExecutable) || (proof.helperExecutableMatchesExpected !== true && !sameWindowsPath(proof.helperExecutable, peer.helperExecutable))
      || typeof proof.helperBirth !== 'string' || !WINDOWS_TIME.test(proof.helperBirth) || !Number.isFinite(Date.parse(proof.helperBirth)) || !SHA.test(proof.helperSha256))) return;
  } else if (proof.birth !== receipt.processStartTime || proof.localPort !== peer.localPort || proof.remotePort !== peer.remotePort
    || proof.owner !== receipt.ownerSid || proof.sha256 !== receipt.executableSha256
    || (proof.executableMatchesExpected !== true && !sameWindowsPath(proof.executable, receipt.executable))) return;
  return createHash('sha256').update(JSON.stringify({ platform: 'win32', pid: proof.pid, birth: proof.birth, boot: proof.boot, executable: path.win32.normalize(proof.executable).toLowerCase(), sha256: proof.sha256, owner: proof.owner, codexHome: path.win32.normalize(proof.codexHome).toLowerCase() })).digest('hex');
}


/** Missing OS/owner/peer evidence is absence of proof, never a diagnostics-PID fallback. */
export async function codexNativeGeneration(peer: CodexNativePeer | undefined, serverId: number, codexHome: string, options: CodexNativeGenerationOptions = {}): Promise<string | undefined> {
  try {
    const platform = options.platform ?? process.platform;
    if (!peer || !Number.isSafeInteger(serverId) || serverId <= 1) return;
    if (platform === 'win32' && peer.kind !== 'proxy') return await windowsGeneration(peer, serverId, codexHome, options);
    if (platform !== 'linux' || peer.kind === 'windows-shared'
      || !Number.isSafeInteger(peer.pid) || peer.pid <= 1) return;
    const home = await realpath(codexHome);
    const result = await execute('/usr/bin/python3', ['-I', '-c', LINUX_PROOF, peer.kind, String(peer.pid), String(serverId), home, peer.kind === 'proxy' ? peer.endpoint : ''], { timeout: 5_000, maxBuffer: 16 * 1024, windowsHide: true });
    const proof = JSON.parse(result.stdout);
    if (proof?.pid !== serverId || proof.codexHome !== home || typeof proof.birth !== 'string' || !/^\d+$/u.test(proof.birth)
      || typeof proof.boot !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(proof.boot)
      || proof.owner !== String(process.getuid?.()) || typeof proof.executable !== 'string' || !path.isAbsolute(proof.executable) || !SHA.test(proof.sha256)) return;
    return createHash('sha256').update(JSON.stringify({ platform: 'linux', pid: proof.pid, birth: proof.birth, boot: proof.boot, executable: proof.executable, sha256: proof.sha256, owner: proof.owner, codexHome: proof.codexHome })).digest('hex');
  } catch { return undefined; }
}
