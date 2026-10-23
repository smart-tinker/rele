param(
    [Parameter(Mandatory=$true)][ValidateSet('Identity','Private','Legacy','Inspect','HoldLock')][string]$Action,
    [string]$Root,
    [string]$Directory
)
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User
if ($Action -eq 'Identity') {
    $elevated = [Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    [Console]::Out.Write('{"elevated":' + $elevated.ToString().ToLowerInvariant() + '}')
    exit 0
}
$rootPath = [IO.Path]::GetFullPath($Root).TrimEnd('\')
$target = [IO.Path]::GetFullPath($Directory).TrimEnd('\')
if ([IO.Path]::GetFileName($rootPath) -cnotmatch '^Rele codex control [A-Za-z0-9]{6}$' -or
    -not $target.StartsWith($rootPath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Expected an owned test directory' }
$info = [IO.DirectoryInfo]::new($target)
if (-not $info.Exists -or ($info.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Expected an existing non-linked test directory' }
$sections = [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group -bor [Security.AccessControl.AccessControlSections]::Access
$acl = $info.GetAccessControl($sections)
if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $sid.Value) { throw 'Test directory owner differs' }
if ($Action -eq 'Private' -or $Action -eq 'Legacy') {
    if ([IO.Directory]::GetFileSystemEntries($target).Length -ne 0) { throw 'ACL setup requires an empty owned directory' }
    # Preserve the existing owner/group; a filtered token needs only WRITE_DAC here.
    $permissions = $acl
    $permissions.SetAccessRuleProtection($true, $false)
    foreach ($rule in $permissions.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier])) {
        $permissions.RemoveAccessRuleSpecific($rule)
    }
    $permissions.SetAccessRuleProtection(($Action -eq 'Private'), $false)
    $permissions.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        $sid, [Security.AccessControl.FileSystemRights]::FullControl,
        ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
        [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
    $info.SetAccessControl($permissions)
    [Console]::Out.Write('owned-acl-ready')
    exit 0
}
if ($Action -eq 'HoldLock') {
    if ([IO.Path]::GetFileName($target) -cne 'app-server-daemon') { throw 'Expected the owned daemon state directory' }
    $lock = [IO.File]::Open([IO.Path]::Combine($target, 'daemon.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::ReadWrite)
    try {
        $lock.Lock(0, 1)
        try {
            [Console]::Out.WriteLine('operation-lock-held')
            [Console]::Out.Flush()
            [void][Console]::In.ReadLine()
        } finally { $lock.Unlock(0, 1) }
    } finally { $lock.Dispose() }
    exit 0
}
$rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
$private = $acl.AreAccessRulesProtected -and $rules.Count -eq 1 -and
    $rules[0].IdentityReference.Value -ceq $sid.Value -and -not $rules[0].IsInherited -and
    $rules[0].AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
    $rules[0].FileSystemRights -eq [Security.AccessControl.FileSystemRights]::FullControl -and
    $rules[0].InheritanceFlags -eq ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit) -and
    $rules[0].PropagationFlags -eq [Security.AccessControl.PropagationFlags]::None
$hash = [Security.Cryptography.SHA256]::Create()
try { $digest = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($acl.GetSecurityDescriptorSddlForm($sections)))).Replace('-', '').ToLowerInvariant() }
finally { $hash.Dispose() }
[Console]::Out.Write('{"ownerMatches":true,"private":' + $private.ToString().ToLowerInvariant() +
    ',"protected":' + $acl.AreAccessRulesProtected.ToString().ToLowerInvariant() + ',"descriptorSha256":"' + $digest + '"}')
