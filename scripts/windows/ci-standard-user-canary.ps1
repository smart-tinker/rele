param([ValidateSet('Parent', 'Child', 'Canary')][string]$Mode = 'Parent', [string]$FixtureRoot, [string]$Nonce)
$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$shell = Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe'
function Quote([string]$Value) { if ($Value.Contains('"')) { throw 'Invalid fixture argument.' }; return '"' + $Value + '"' }
function Token-Elevated {
    $helper = Join-Path $FixtureRoot 'FixtureElevation.exe'
    $result = & $helper $PID ([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName)
    if ($LASTEXITCODE -ne 0) { throw 'Fixture process token could not be verified.' }
    return ($result | ConvertFrom-Json).elevated
}
function Remove-Canary([string]$Sid) {
    $scheduler = New-Object -ComObject 'Schedule.Service'; $scheduler.Connect(); $folder = $scheduler.GetFolder('\')
    $name = 'Rele-CI-Canary-' + $Nonce
    try { $task = $folder.GetTask($name) } catch { return }
    $definition = $task.Definition
    $owner = [string]$definition.Principal.UserId
    if ($owner -notmatch '^S-1-') { $owner = (New-Object Security.Principal.NTAccount $owner).Translate([Security.Principal.SecurityIdentifier]).Value }
    if ($owner -ne $Sid -or $definition.Actions.Count -ne 1 -or $definition.Actions.Item(1).Path -ne $shell -or -not $definition.Actions.Item(1).Arguments.Contains($Nonce)) { throw 'Refusing to remove a foreign canary task.' }
    try { $task.Stop(0) } catch { }
    $folder.DeleteTask($name, 0)
}

if ($Mode -eq 'Canary') {
    $marker = Get-Content -LiteralPath (Join-Path $FixtureRoot 'parent.json') -Raw | ConvertFrom-Json
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ($marker.nonce -ne $Nonce -or $marker.sid -ne $sid) { throw 'Canary fixture identity mismatch.' }
    $elevated = Token-Elevated
    if ($elevated) { throw 'InteractiveToken canary ran elevated.' }
    $receipt = @{ nonce = $Nonce; sid = $sid; elevated = $elevated } | ConvertTo-Json -Compress
    $file = [IO.File]::Open((Join-Path $FixtureRoot 'canary.json'), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $bytes = [Text.Encoding]::UTF8.GetBytes($receipt); $file.Write($bytes, 0, $bytes.Length) } finally { $file.Dispose() }
    exit 0
}

if ($Mode -eq 'Child') {
    $marker = Get-Content -LiteralPath (Join-Path $FixtureRoot 'parent.json') -Raw | ConvertFrom-Json
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ($marker.nonce -ne $Nonce -or $marker.sid -ne $sid) { throw 'Standard-user fixture identity mismatch.' }
    $profile = [Environment]::GetFolderPath('UserProfile')
    $system = [Environment]::GetFolderPath('System'); $windows = [IO.Directory]::GetParent($system).FullName
    foreach ($entry in @(Get-ChildItem Env:)) { Remove-Item -LiteralPath ('Env:' + $entry.Name) }
    $env:SystemRoot = $windows; $env:WINDIR = $windows; $env:ComSpec = Join-Path $system 'cmd.exe'; $env:PATH = $system
    $env:USERPROFILE = $profile; $env:LOCALAPPDATA = Join-Path $profile 'AppData\Local'; $env:APPDATA = Join-Path $profile 'AppData\Roaming'
    $env:TEMP = Join-Path $FixtureRoot 'tmp'; $env:TMP = $env:TEMP
    New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
    $evidence = @{ result = 'failed'; selfElevated = $null; taskElevated = $null; stage = 'token' }
    try {
        $compiler = Join-Path $windows 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
        & $compiler /nologo /target:exe /platform:x64 /codepage:65001 ('/out:' + (Join-Path $FixtureRoot 'FixtureElevation.exe')) (Join-Path $PSScriptRoot 'FixtureElevation.cs')
        if ($LASTEXITCODE -ne 0) { throw 'Fixture elevation helper compilation failed.' }
        $evidence.selfElevated = Token-Elevated
        if ($evidence.selfElevated) { throw 'Standard-user child ran elevated.' }
        $evidence.stage = 'interactive-token'
        $scheduler = New-Object -ComObject 'Schedule.Service'; $scheduler.Connect(); $folder = $scheduler.GetFolder('\')
        $definition = $scheduler.NewTask(0)
        $definition.Principal.UserId = $sid; $definition.Principal.LogonType = 3; $definition.Principal.RunLevel = 0
        $definition.Settings.ExecutionTimeLimit = 'PT30S'; $definition.Settings.DisallowStartIfOnBatteries = $false; $definition.Settings.StopIfGoingOnBatteries = $false
        $action = $definition.Actions.Create(0); $action.Path = $shell; $action.WorkingDirectory = $FixtureRoot
        $action.Arguments = '-NoProfile -NonInteractive -File ' + (Quote $PSCommandPath) + ' -Mode Canary -FixtureRoot ' + (Quote $FixtureRoot) + ' -Nonce ' + $Nonce
        $task = $folder.RegisterTaskDefinition(('Rele-CI-Canary-' + $Nonce), $definition, 2, $sid, $null, 3, $null)
        $task.Run($null) | Out-Null
        $deadline = [DateTime]::UtcNow.AddSeconds(20); $receiptPath = Join-Path $FixtureRoot 'canary.json'
        while ([DateTime]::UtcNow -lt $deadline -and (-not (Test-Path -LiteralPath $receiptPath) -or $task.LastTaskResult -ne 0)) { Start-Sleep -Milliseconds 100 }
        $evidence.lastTaskResult = ('0x{0:X8}' -f $task.LastTaskResult)
        if (-not (Test-Path -LiteralPath $receiptPath) -or $task.LastTaskResult -ne 0) { throw ('InteractiveToken canary did not complete; LastTaskResult=' + $evidence.lastTaskResult) }
        $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
        if ($receipt.nonce -ne $Nonce -or $receipt.sid -ne $sid -or $receipt.elevated -ne $false) { throw 'Invalid InteractiveToken canary receipt.' }
        $evidence.taskElevated = $receipt.elevated; $evidence.result = 'passed'; $evidence.stage = 'complete'
    } catch { $evidence.error = $_.Exception.Message }
    finally {
        Remove-Canary $sid
        $evidence | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $FixtureRoot 'windows-standard-user-results.json') -Encoding UTF8
    }
    if ($evidence.result -ne 'passed') { throw $evidence.error }
    exit 0
}

if ($env:GITHUB_ACTIONS -ne 'true' -or $env:CI -ne 'true' -or $env:RUNNER_OS -ne 'Windows') { throw 'Run this canary only on a disposable GitHub Windows runner.' }
$Nonce = [Guid]::NewGuid().ToString('N'); $account = 'ReleCi' + $Nonce.Substring(0, 8)
$FixtureRoot = Join-Path ([IO.Path]::GetPathRoot($env:RUNNER_TEMP)) ('rc-' + $Nonce.Substring(0, 8))
if (Test-Path -LiteralPath $FixtureRoot) { throw 'Fixture directory already exists.' }
New-Item -ItemType Directory -Path $FixtureRoot | Out-Null
$user = $null; $child = $null; $credential = $null; $password = $null
try {
    $bytes = New-Object byte[] 32; $random = [Security.Cryptography.RandomNumberGenerator]::Create(); $random.GetBytes($bytes); $random.Dispose()
    $password = ConvertTo-SecureString ('Aa1!' + [Convert]::ToBase64String($bytes)) -AsPlainText -Force; [Array]::Clear($bytes, 0, $bytes.Length)
    $user = New-LocalUser -Name $account -Password $password -AccountNeverExpires -PasswordNeverExpires -Description 'Disposable Rele native CI fixture'
    $sid = $user.SID.Value
    if (@(Get-LocalGroupMember -SID 'S-1-5-32-545' | Where-Object { $_.SID.Value -eq $sid }).Count -eq 0) { Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $account }
    if (@(Get-LocalGroupMember -SID 'S-1-5-32-544' | Where-Object { $_.SID.Value -eq $sid }).Count -ne 0) { throw 'Fixture user must not be an administrator.' }
    & icacls.exe $sourceRoot /grant ('*' + $sid + ':(OI)(CI)(RX)') /T /C | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot grant fixture source read access.' }
    & icacls.exe $FixtureRoot /grant ('*' + $sid + ':(OI)(CI)(M)') /T /C | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot grant fixture write access.' }
    @{ nonce = $Nonce; sid = $sid } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $FixtureRoot 'parent.json') -Encoding UTF8
    $credential = New-Object System.Management.Automation.PSCredential ($env:COMPUTERNAME + '\' + $account), $password
    $arguments = '-NoProfile -NonInteractive -File ' + (Quote $PSCommandPath) + ' -Mode Child -FixtureRoot ' + (Quote $FixtureRoot) + ' -Nonce ' + $Nonce
    $child = Start-Process -FilePath $shell -ArgumentList $arguments -Credential $credential -LoadUserProfile -UseNewEnvironment -WorkingDirectory $FixtureRoot -RedirectStandardOutput (Join-Path $FixtureRoot 'stdout.log') -RedirectStandardError (Join-Path $FixtureRoot 'stderr.log') -PassThru
    $credential = $null; $password.Dispose(); $password = $null
    if (-not $child.WaitForExit(60000)) { throw 'Standard-user canary child timed out.' }
    $resultPath = Join-Path $FixtureRoot 'windows-standard-user-results.json'
    if (Test-Path -LiteralPath $resultPath) { Get-Content -LiteralPath $resultPath -Raw | Write-Output; Copy-Item -LiteralPath $resultPath -Destination (Join-Path $sourceRoot 'windows-standard-user-results.json') }
    if ($child.ExitCode -ne 0) { Get-Content -LiteralPath (Join-Path $FixtureRoot 'stderr.log') -Tail 30 | Write-Output; throw 'Standard-user InteractiveToken canary failed; native gates must not run in this environment.' }
} finally {
    $credential = $null; if ($password) { $password.Dispose() }
    if ($child -and -not $child.HasExited) { Stop-Process -Id $child.Id -Force }
    if ($user) {
        Remove-Canary $user.SID.Value
        Remove-LocalUser -SID $user.SID
        Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $user.SID.Value } | Remove-CimInstance
    }
    Remove-Item -LiteralPath $FixtureRoot -Recurse -Force
}
