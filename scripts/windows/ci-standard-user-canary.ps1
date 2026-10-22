param([ValidateSet('Parent', 'Child')][string]$Mode = 'Parent', [string]$FixtureRoot, [string]$Nonce, [switch]$RunGates, [ValidateSet('Shared', 'Installer')][string]$Phase = 'Installer', [string]$DesktopBundle, [string]$DesktopInventory, [switch]$StandaloneShared, [string]$PowerShell7Path)
$ErrorActionPreference = 'Stop'
if ($StandaloneShared -and ($Mode -ne 'Parent' -or -not $RunGates -or $Phase -ne 'Shared')) { throw 'Standalone mode requires Parent -RunGates -Phase Shared.' }
if ($Phase -eq 'Shared' -and -not $RunGates) { throw 'Shared-only mode requires -RunGates.' }
if (($DesktopBundle -or $DesktopInventory) -and ($Mode -ne 'Parent' -or $Phase -ne 'Shared' -or -not $RunGates -or -not $DesktopBundle -or -not $DesktopInventory)) { throw 'Actual Desktop inputs require Parent -RunGates -Phase Shared and both payload and inventory paths.' }
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$shell = if ($PowerShell7Path) { $PowerShell7Path } else { Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'PowerShell\7\pwsh.exe' }
if (-not [IO.Path]::IsPathFullyQualified($shell) -or [IO.Path]::GetFileName($shell) -ine 'pwsh.exe' -or -not (Test-Path -LiteralPath $shell -PathType Leaf) -or [Diagnostics.FileVersionInfo]::GetVersionInfo($shell).FileMajorPart -ne 7) { throw 'A fully qualified PowerShell 7 executable is required for this canary.' }
if ($PowerShell7Path -and (Get-AuthenticodeSignature -LiteralPath $shell).Status -ne 'Valid') { throw 'The portable PowerShell 7 executable must have a valid Authenticode signature.' }
function Assert-StandaloneScratchTree([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if (-not $full.StartsWith(($standaloneRoot + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Standalone source and tools must be disposable copies under RUNNER_TEMP.' }
    $entry = Get-Item -LiteralPath $full -Force
    while ($entry) {
        if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Standalone fixture paths must not contain reparse points.' }
        $entry = $entry.Parent
    }
    if (Get-ChildItem -LiteralPath $full -Recurse -Force -Attributes ReparsePoint | Select-Object -First 1) { throw 'Standalone fixture trees must not contain reparse points.' }
}
function Quote([string]$Value) { if ($Value.Contains('"')) { throw 'Invalid fixture argument.' }; return '"' + $Value + '"' }
function Token-Elevated {
    $helper = Join-Path $FixtureRoot 'FixtureElevation.exe'
    $result = & $helper $PID ([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName)
    if ($LASTEXITCODE -ne 0) { throw 'Fixture process token could not be verified.' }
    return ($result | ConvertFrom-Json).elevated
}
function Read-RdpMode {
    $result = @{ fDenyTSConnections = (Get-Item -LiteralPath $terminalPath).GetValue('fDenyTSConnections', $null) }
    try {
        $mode = Get-CimInstance -Namespace 'root/cimv2/TerminalServices' -ClassName Win32_TerminalServiceSetting -Property AllowTSConnections, PolicySourceAllowTSConnections
        $result.allowTSConnections = [int]$mode.AllowTSConnections; $result.policySourceAllowTSConnections = [int]$mode.PolicySourceAllowTSConnections
    } catch { $result.errorHResult = ('0x{0:X8}' -f $_.Exception.HResult) }
    return $result
}
function Remove-Canary([string]$Sid) {
    $scheduler = New-Object -ComObject 'Schedule.Service'; $scheduler.Connect(); $folder = $scheduler.GetFolder('\')
    $name = 'Rele-CI-Canary-' + $Nonce
    try { $task = $folder.GetTask($name) } catch { return }
    $definition = $task.Definition
    $owner = [string]$definition.Principal.UserId
    if ($owner -notmatch '^S-1-') { $owner = (New-Object Security.Principal.NTAccount $owner).Translate([Security.Principal.SecurityIdentifier]).Value }
    $arguments = '--canary ' + (Quote $FixtureRoot) + ' ' + $Nonce + ' ' + $Sid
    if ($owner -ne $Sid -or $definition.Actions.Count -ne 1 -or $definition.Actions.Item(1).Path -ne (Join-Path $FixtureRoot 'FixtureElevation.exe') -or $definition.Actions.Item(1).Arguments -ne $arguments) { throw 'Refusing to remove a foreign canary task.' }
    try { $task.Stop(0) } catch { }
    $folder.DeleteTask($name, 0)
}
function Remove-FixtureProfile([string]$Sid, [hashtable]$Facts) {
    $deadline = [DateTime]::UtcNow.AddSeconds(20); $lastError = $null
    do {
        $profile = Get-CimInstance Win32_UserProfile -Filter ("SID='$Sid'")
        if ($profile -and $profile.Special) { throw 'Refusing to remove a special user profile.' }
        if ($profile -and -not $profile.Loaded) {
            try { $profile | Remove-CimInstance; $lastError = $null } catch { $lastError = $_.Exception }
            $profile = Get-CimInstance Win32_UserProfile -Filter ("SID='$Sid'")
        }
        if (-not $profile) {
            $remainingHive = [Microsoft.Win32.Registry]::Users.OpenSubKey($Sid)
            try { if (-not $remainingHive) { $Facts.profileAbsent = $true; $Facts.hivePresent = $false; return } }
            finally { if ($remainingHive) { $remainingHive.Dispose() } }
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    $Facts.cimLoaded = [bool]$profile.Loaded
    $Facts.profileAbsent = $null -eq $profile
    $hive = $null; $profileKey = $null
    try {
        $hive = [Microsoft.Win32.Registry]::Users.OpenSubKey($Sid)
        $Facts.hivePresent = $null -ne $hive
        $profileKey = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\' + $Sid)
        $Facts.profileListPresent = $null -ne $profileKey
        if ($profileKey) {
            foreach ($name in @('State', 'Flags', 'RefCount')) {
                $value = $profileKey.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                if ($value -is [int] -or $value -is [long]) { $Facts[$name] = $value }
            }
        }
    } catch { $Facts.registryErrorHResult = ('0x{0:X8}' -f $_.Exception.HResult) }
    finally { if ($profileKey) { $profileKey.Dispose() }; if ($hive) { $hive.Dispose() } }
    $detail = if ($lastError) { $lastError.Message } else { 'The fixture profile is still loaded.' }
    throw ('Fixture profile cleanup timed out; Loaded=' + $profile.Loaded + '; refCount=' + $profile.refCount + '; ' + $detail)
}

if ($Mode -eq 'Child') {
    $marker = Get-Content -LiteralPath (Join-Path $FixtureRoot 'parent.json') -Raw | ConvertFrom-Json
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ($marker.nonce -ne $Nonce -or $marker.sid -ne $sid -or $marker.phase -ne $Phase -or [bool]$marker.runGates -ne $RunGates.IsPresent -or ($Phase -eq 'Shared' -and -not $RunGates)) { throw 'Standard-user fixture identity mismatch.' }
    $profile = [Environment]::GetFolderPath('UserProfile')
    $system = [Environment]::GetFolderPath('System'); $windows = [IO.Directory]::GetParent($system).FullName
    foreach ($entry in @(Get-ChildItem Env:)) { Remove-Item -LiteralPath ('Env:' + $entry.Name) }
    $env:SystemRoot = $windows; $env:WINDIR = $windows; $env:ComSpec = Join-Path $system 'cmd.exe'; $env:PATH = $system
    $env:USERPROFILE = $profile; $env:LOCALAPPDATA = Join-Path $profile 'AppData\Local'; $env:APPDATA = Join-Path $profile 'AppData\Roaming'
    $env:TEMP = Join-Path $FixtureRoot 'tmp'; $env:TMP = $env:TEMP
    New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
    $evidence = @{ nonce = $Nonce; sid = $sid; phase = $Phase; result = 'failed'; selfElevated = $null; taskElevated = $null; stage = 'token'; selfSessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId }
    $task = $null; $running = $null
    try {
        $compiler = Join-Path $windows 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
        & $compiler /nologo /target:exe /platform:x64 /codepage:65001 ('/out:' + (Join-Path $FixtureRoot 'FixtureElevation.exe')) (Join-Path $PSScriptRoot 'FixtureElevation.cs')
        if ($LASTEXITCODE -ne 0) { throw 'Fixture elevation helper compilation failed.' }
        $evidence.selfElevated = Token-Elevated
        if ($evidence.selfElevated) { throw 'Standard-user child ran elevated.' }
        if ($RunGates) {
            $env:CI = 'true'; $env:RUNNER_OS = 'Windows'; $env:RUNNER_TEMP = $env:TEMP
            $env:PATH = @((Split-Path $marker.node), (Split-Path $marker.python), (Join-Path (Split-Path $marker.python) 'Scripts'), $system, (Join-Path $system 'WindowsPowerShell\v1.0')) -join ';'
            $env:PYTHONNOUSERSITE = '1'; $env:PYTHONDONTWRITEBYTECODE = '1'
            $env:RELE_TEST_REPORT_DIR = Join-Path $FixtureRoot 'reports'; New-Item -ItemType Directory -Path $env:RELE_TEST_REPORT_DIR -Force | Out-Null
            if (-not $marker.desktopBundle) { $env:RELE_TEST_CODEX_PREFIX = $marker.prefixes[0]; $env:RELE_TEST_CODEX_VERSION = '0.163.0' }
            $evidence.gates = @()
        }
        if ($Phase -eq 'Shared') {
            if ($marker.desktopBundle) {
                $evidence.stage = 'shared-actual-desktop'
                & $marker.python (Join-Path $sourceRoot 'scripts\shared-protocol-probe.py') --desktop-bundle $marker.desktopBundle --desktop-inventory $marker.desktopInventory --expected-version $marker.desktopVersion --report (Join-Path $env:RELE_TEST_REPORT_DIR 'shared-results-actual-desktop.json')
                if ($LASTEXITCODE -ne 0) { throw 'The standard-user actual Desktop bootstrap gate failed.' }
                $evidence.gates += 'shared-actual-desktop'
                $evidence.actualDesktopGui = $false
            } else {
                $evidence.stage = 'native-cleanup'
                & $marker.node (Join-Path $sourceRoot 'scripts\probe-installer-cleanup.mjs') --native
                if ($LASTEXITCODE -ne 0) { throw 'The standard-user native stop/workdir cleanup gate failed.' }
                $evidence.gates += 'native-cleanup'
                $versions = @('0.163.0', '0.163.0-alpha.10.2', '0.163.0-alpha.11')
                for ($index = 0; $index -lt $versions.Count; $index++) {
                    $version = $versions[$index]; $evidence.stage = 'shared-' + $version
                    & $marker.python (Join-Path $sourceRoot 'scripts\shared-protocol-probe.py') --codex-prefix $marker.prefixes[$index] --expected-version $version --report (Join-Path $env:RELE_TEST_REPORT_DIR ('shared-results-' + $version + '.json'))
                    if ($LASTEXITCODE -ne 0) { throw ('The standard-user native shared gate failed for ' + $version + '.') }
                    $evidence.gates += 'shared-' + $version
                }
            }
        } else {
            $evidence.stage = 'interactive-token'
            $scheduler = New-Object -ComObject 'Schedule.Service'; $scheduler.Connect(); $folder = $scheduler.GetFolder('\')
            $definition = $scheduler.NewTask(0)
            $definition.Principal.UserId = $sid; $definition.Principal.LogonType = 3; $definition.Principal.RunLevel = 0
            $definition.Settings.ExecutionTimeLimit = 'PT30S'; $definition.Settings.DisallowStartIfOnBatteries = $false; $definition.Settings.StopIfGoingOnBatteries = $false
            $action = $definition.Actions.Create(0); $action.Path = Join-Path $FixtureRoot 'FixtureElevation.exe'; $action.WorkingDirectory = $FixtureRoot
            $action.Arguments = '--canary ' + (Quote $FixtureRoot) + ' ' + $Nonce + ' ' + $sid
            $task = $folder.RegisterTaskDefinition(('Rele-CI-Canary-' + $Nonce), $definition, 2, $sid, $null, 3, $null)
            $evidence.runMode = 'registered-user'
            $running = $task.Run($null)
            $evidence.runReturned = $true
            $deadline = [DateTime]::UtcNow.AddSeconds(20); $receiptPath = Join-Path $FixtureRoot 'canary.json'
            while ([DateTime]::UtcNow -lt $deadline -and (-not (Test-Path -LiteralPath $receiptPath) -or $task.LastTaskResult -ne 0)) { Start-Sleep -Milliseconds 100 }
            $evidence.lastTaskResult = ('0x{0:X8}' -f $task.LastTaskResult)
            if (-not (Test-Path -LiteralPath $receiptPath) -or $task.LastTaskResult -ne 0) { throw ('InteractiveToken canary did not complete; LastTaskResult=' + $evidence.lastTaskResult) }
            $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
            if ($receipt.nonce -ne $Nonce -or $receipt.sid -ne $sid -or $receipt.elevated -ne $false -or $receipt.sessionId -ne $marker.rdpSessionId) { throw 'Invalid InteractiveToken canary receipt.' }
            $evidence.taskElevated = $receipt.elevated; $evidence.taskSessionId = $receipt.sessionId; $evidence.canary = 'passed'
            if ($RunGates) {
                $evidence.stage = 'installer'
                & $marker.node (Join-Path $sourceRoot 'scripts\smoke-windows-installer.mjs')
                if ($LASTEXITCODE -ne 0) { throw 'The standard-user Windows installer lifecycle gate failed.' }
                $evidence.gates += 'installer'
            }
        }
        $evidence.result = 'passed'; $evidence.stage = 'complete'
    } catch {
        $evidence.error = $_.Exception.Message
        $evidence.errorHResult = ('0x{0:X8}' -f $_.Exception.HResult)
        if ($_.Exception.InnerException) { $evidence.innerErrorHResult = ('0x{0:X8}' -f $_.Exception.InnerException.HResult) }
    }
    finally {
        try {
            if ($task) {
                $fresh = $folder.GetTask('Rele-CI-Canary-' + $Nonce)
                $settings = $fresh.Definition.Settings
                $evidence.registeredTask = @{ state = [int]$fresh.State; lastTaskResult = ('0x{0:X8}' -f $fresh.LastTaskResult); lastRunTime = $fresh.LastRunTime.ToUniversalTime().ToString('o'); enabled = [bool]$settings.Enabled; allowDemandStart = [bool]$settings.AllowDemandStart; runOnlyIfIdle = [bool]$settings.RunOnlyIfIdle; runOnlyIfNetworkAvailable = [bool]$settings.RunOnlyIfNetworkAvailable }
            }
            if ($running) {
                $running.Refresh()
                $evidence.runningTask = @{ state = [int]$running.State; enginePid = [int]$running.EnginePID; currentAction = [string]$running.CurrentAction }
            }
        } catch { $evidence.taskEvidenceError = $_.Exception.Message }
        $canaryError = Join-Path $FixtureRoot 'canary-error.json'
        if (Test-Path -LiteralPath $canaryError) { $evidence.canaryError = Get-Content -LiteralPath $canaryError -Raw | ConvertFrom-Json }
        try { if ($Phase -eq 'Installer') { Remove-Canary $sid } } catch { $evidence.cleanupError = $_.Exception.Message; $evidence.result = 'failed' }
        $evidence | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $FixtureRoot 'windows-standard-user-results.json') -Encoding UTF8
    }
    if ($evidence.result -ne 'passed') { throw $evidence.error }
    exit 0
}

if (-not $StandaloneShared -and ($env:GITHUB_ACTIONS -ne 'true' -or $env:CI -ne 'true' -or $env:RUNNER_OS -ne 'Windows')) { throw 'Run this canary only on a disposable GitHub Windows runner.' }
$standaloneRoot = $null
if ($StandaloneShared) {
    if (-not $env:RUNNER_TEMP -or -not [IO.Path]::IsPathFullyQualified($env:RUNNER_TEMP) -or -not (Test-Path -LiteralPath $env:RUNNER_TEMP -PathType Container)) { throw 'Standalone mode requires an explicit disposable RUNNER_TEMP directory.' }
    $standaloneRoot = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')
    if ($standaloneRoot -eq [IO.Path]::GetPathRoot($standaloneRoot).TrimEnd('\')) { throw 'Standalone RUNNER_TEMP must not be a volume root.' }
    Assert-StandaloneScratchTree $sourceRoot
    Assert-StandaloneScratchTree (Split-Path $shell)
}
$Nonce = [Guid]::NewGuid().ToString('N'); $account = 'ReleCi' + $Nonce.Substring(0, 8)
$operationalLog = 'Microsoft-Windows-TaskScheduler/Operational'
if ($Phase -eq 'Installer') {
    & (Join-Path ([Environment]::GetFolderPath('System')) 'wevtutil.exe') sl $operationalLog /e:true
    if ($LASTEXITCODE -ne 0) { throw 'Cannot enable the disposable runner Task Scheduler diagnostic channel.' }
}
$fixtureParent = if ($StandaloneShared) { $standaloneRoot } else { [IO.Path]::GetPathRoot($env:RUNNER_TEMP) }
$FixtureRoot = Join-Path $fixtureParent ('rc-' + $Nonce.Substring(0, 8))
if (Test-Path -LiteralPath $FixtureRoot) { throw 'Fixture directory already exists.' }
New-Item -ItemType Directory -Path $FixtureRoot | Out-Null
$user = $null; $child = $null; $credential = $null; $password = $null; $rdp = $null; $sharedOutcome = $null; $gatesDeadline = $null; $parentStage = 'setup'
$rdpSettingsChanged = $false; $serviceStartupChanged = $false; $serviceStarted = $false
$redirectorStartupChanged = $false; $redirectorStarted = $false
$rdpStartedAt = $null; $rdpModeBefore = $null; $rdpModeAfter = $null; $rdpTransport = @{}
$rdpClientLog = 'Microsoft-Windows-TerminalServices-RDPClient/Operational'
$terminalPath = 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server'
try {
    $bytes = New-Object byte[] 32; $random = [Security.Cryptography.RandomNumberGenerator]::Create(); $random.GetBytes($bytes); $random.Dispose()
    $password = ConvertTo-SecureString ('Aa1!' + [Convert]::ToBase64String($bytes)) -AsPlainText -Force; [Array]::Clear($bytes, 0, $bytes.Length)
    $user = New-LocalUser -Name $account -Password $password -AccountNeverExpires -PasswordNeverExpires -Description 'Disposable Rele native CI fixture'
    $sid = $user.SID.Value
    if (@(Get-LocalGroupMember -SID 'S-1-5-32-545' | Where-Object { $_.SID.Value -eq $sid }).Count -eq 0) { Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $account }
    if (@(Get-LocalGroupMember -SID 'S-1-5-32-544' | Where-Object { $_.SID.Value -eq $sid }).Count -ne 0) { throw 'Fixture user must not be an administrator.' }
    if ($Phase -eq 'Installer') { Add-LocalGroupMember -SID 'S-1-5-32-555' -Member $account }
    & icacls.exe $sourceRoot /grant ('*' + $sid + ':(OI)(CI)(RX)') /T /C | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot grant fixture source read access.' }
    & icacls.exe $FixtureRoot /grant ('*' + $sid + ':(OI)(CI)(M)') /T /C | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot grant fixture write access.' }
    $marker = @{ nonce = $Nonce; sid = $sid; phase = 'Installer'; runGates = $RunGates.IsPresent; desktopBundle = $null; desktopInventory = $null }
    if ($RunGates) {
        $marker.node = (Get-Command node.exe -CommandType Application -TotalCount 1 -ErrorAction Stop).Source
        $marker.python = (Get-Command python.exe -CommandType Application -TotalCount 1 -ErrorAction Stop).Source
        foreach ($executable in @($marker.node, $marker.python)) {
            if ($executable -isnot [string] -or -not [IO.Path]::IsPathFullyQualified($executable) -or [IO.Path]::GetExtension($executable) -ne '.exe' -or -not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'An isolated gate runtime must resolve to one fully qualified executable.' }
        }
        $marker.prefixes = @()
        $desktopReadPaths = @()
        if ($DesktopBundle) {
            $marker.desktopBundle = [IO.Path]::GetFullPath($DesktopBundle)
            $marker.desktopInventory = [IO.Path]::GetFullPath($DesktopInventory)
            $runnerRoot = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'
            foreach ($path in @($marker.desktopBundle, $marker.desktopInventory)) {
                if (-not $path.StartsWith($runnerRoot, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $path)) { throw 'Desktop gate inputs must be existing paths under this disposable RUNNER_TEMP.' }
            }
            $inventory = Get-Content -LiteralPath $marker.desktopInventory -Raw | ConvertFrom-Json
            if ($inventory.result -ne 'passed' -or $inventory.nativeGatePrepared -ne $true -or $inventory.package.signature.status -ne 'Valid' -or $inventory.backendVersion -notin @('0.163.0', '0.163.0-alpha.10.2', '0.163.0-alpha.11')) { throw 'The actual Desktop inventory is not a successful signed and versioned preparation.' }
            $marker.desktopVersion = $inventory.backendVersion
            $desktopReadPaths = @($marker.desktopBundle, (Split-Path $marker.desktopInventory))
        } else {
            $marker.prefixes = @('0.163.0', '0.163.0-alpha.10.2', '0.163.0-alpha.11') | ForEach-Object { Join-Path $env:RUNNER_TEMP ('codex-probe-' + $_) }
        }
        $portableShellPaths = if ($StandaloneShared) { @((Split-Path $shell)) } else { @() }
        foreach ($path in (@((Split-Path $marker.node), (Split-Path $marker.python)) + $marker.prefixes + $desktopReadPaths + $portableShellPaths)) {
            if (-not (Test-Path -LiteralPath $path -PathType Container) -or -not [IO.Path]::IsPathRooted($path)) { throw 'An isolated gate runtime or native package is unavailable.' }
            if ($StandaloneShared) { Assert-StandaloneScratchTree $path }
            & icacls.exe $path /grant ('*' + $sid + ':(OI)(CI)(RX)') /T /C | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'Cannot grant fixture gate runtime read access.' }
        }
    }
    $credential = New-Object System.Management.Automation.PSCredential ($env:COMPUTERNAME + '\' + $account), $password
    $resultPath = Join-Path $FixtureRoot 'windows-standard-user-results.json'
    if ($RunGates) { $gatesDeadline = [DateTime]::UtcNow.AddMinutes($(if ($DesktopBundle) { 5 } else { 20 })) }
    if ($RunGates) {
        $parentStage = 'shared'
        $marker.phase = 'Shared'; $marker | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $FixtureRoot 'parent.json') -Encoding UTF8
        $arguments = '-NoProfile -NonInteractive -File ' + (Quote $PSCommandPath) + ' -Mode Child -FixtureRoot ' + (Quote $FixtureRoot) + ' -Nonce ' + $Nonce + ' -RunGates -Phase Shared'
        if ($PowerShell7Path) { $arguments += ' -PowerShell7Path ' + (Quote $shell) }
        $child = Start-Process -FilePath $shell -ArgumentList $arguments -Credential $credential -LoadUserProfile -UseNewEnvironment -WorkingDirectory $FixtureRoot -RedirectStandardOutput (Join-Path $FixtureRoot 'stdout.log') -RedirectStandardError (Join-Path $FixtureRoot 'stderr.log') -PassThru
        $remaining = [Math]::Max(0, [int](($gatesDeadline - [DateTime]::UtcNow).TotalMilliseconds))
        if (-not $child.WaitForExit($remaining)) { throw 'The standard-user shared phase timed out.' }
        if (-not (Test-Path -LiteralPath $resultPath)) { throw 'The standard-user shared phase did not produce a receipt.' }
        $receipt = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
        if ($receipt.nonce -ne $Nonce -or $receipt.sid -ne $sid -or $receipt.phase -ne 'Shared') { throw 'Invalid standard-user shared phase receipt.' }
        $receipt.PSObject.Properties.Remove('nonce'); $receipt.PSObject.Properties.Remove('sid'); $sharedOutcome = $receipt
        if ($child.ExitCode -ne 0 -or $receipt.result -ne 'passed' -or $receipt.selfElevated -ne $false) { foreach ($log in @('stdout.log', 'stderr.log')) { Get-Content -LiteralPath (Join-Path $FixtureRoot $log) -Tail 30 | Write-Output }; throw 'The standard-user native shared phase failed.' }
        $child.Dispose(); $child = $null
        Remove-Item -LiteralPath $resultPath
        if ($Phase -eq 'Shared') {
            $sharedOutcome | Add-Member -NotePropertyName rdpUsed -NotePropertyValue $false
            $sharedOutcome | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $sourceRoot 'windows-standard-user-results.json') -Encoding UTF8
            return
        }
        $marker.phase = 'Installer'
    }
    $parentStage = 'rdp-session'
    $marker | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $FixtureRoot 'parent.json') -Encoding UTF8
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    $rdpAssembly = Join-Path $FixtureRoot 'FixtureRdpSession.dll'
    & $compiler /nologo /target:library /platform:x64 /codepage:65001 ('/out:' + $rdpAssembly) (Join-Path $PSScriptRoot 'FixtureRdpSession.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Loopback RDP fixture helper compilation failed.' }
    [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($rdpAssembly)) | Out-Null
    Remove-Item -LiteralPath $rdpAssembly
    try {
        $provider = Get-WinEvent -ListProvider 'Microsoft-Windows-TerminalServices-ClientActiveXCore'
        if (@($provider.LogLinks | Where-Object { $_.LogName -eq $rdpClientLog }).Count -ne 1) { throw 'The fixed RDP client diagnostic channel is unavailable.' }
        & (Join-Path ([Environment]::GetFolderPath('System')) 'wevtutil.exe') sl $rdpClientLog /e:true
        if ($LASTEXITCODE -ne 0) { throw 'Cannot enable the fixed RDP client diagnostic channel.' }
    } catch { $rdpTransport.logSetupErrorHResult = ('0x{0:X8}' -f $_.Exception.HResult) }
    $rdpModeBefore = Read-RdpMode
    $priorDeny = (Get-Item -LiteralPath $terminalPath).GetValue('fDenyTSConnections', $null)
    if ($null -eq $priorDeny -or $priorDeny -ne 0) { Set-ItemProperty -LiteralPath $terminalPath -Name fDenyTSConnections -Value 0; $rdpSettingsChanged = $true }
    $service = Get-Service -Name TermService
    $redirector = Get-Service -Name UmRdpService
    $rdpTransport.servicesBefore = @{ TermService = [string]$service.Status; UmRdpService = [string]$redirector.Status }
    $priorServiceStartup = $service.StartType
    $priorRedirectorStartup = $redirector.StartType
    if ($priorServiceStartup -eq 'Disabled') { Set-Service -Name TermService -StartupType Manual; $serviceStartupChanged = $true }
    if ($service.Status -ne 'Running') { Start-Service -Name TermService; $serviceStarted = $true }
    if ($priorRedirectorStartup -eq 'Disabled') { Set-Service -Name UmRdpService -StartupType Manual; $redirectorStartupChanged = $true }
    if ($redirector.Status -ne 'Running') { $redirectorStarted = $true; $redirector.Refresh(); if ($redirector.Status -eq 'Stopped') { $redirector.Start() } }
    $redirector.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(10))
    $service.Refresh(); $redirector.Refresh()
    $rdpTransport.servicesAfter = @{ TermService = [string]$service.Status; UmRdpService = [string]$redirector.Status }
    $listenerDeadline = [DateTime]::UtcNow.AddSeconds(10)
    while (-not (Get-NetTCPConnection -LocalPort 3389 -State Listen -ErrorAction SilentlyContinue)) {
        if ([DateTime]::UtcNow -ge $listenerDeadline) { throw 'The disposable runner RDP listener did not become ready.' }
        Start-Sleep -Milliseconds 100
    }
    $rdpModeAfter = Read-RdpMode
    $rdp = [FixtureRdpSession]::new($account, $env:COMPUTERNAME, $password, $sid)
    try { $rdpTransport.logonRights = [FixtureRdpSession]::ReadRemoteLogonRights($sid) }
    catch { $rdpTransport.logonRightsErrorHResult = ('0x{0:X8}' -f $_.Exception.HResult) }
    if ($RunGates -and ($gatesDeadline - [DateTime]::UtcNow).TotalSeconds -lt 60) { throw 'The common native gate deadline has insufficient time for the unchanged RDP timeout.' }
    $rdpStartedAt = [DateTime]::UtcNow
    $rdp.Connect($FixtureRoot, $Nonce)
    $parentStage = 'installer'
    $marker.rdpSessionId = $rdp.SessionId; $marker | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $FixtureRoot 'parent.json') -Encoding UTF8
    $arguments = '-NoProfile -NonInteractive -File ' + (Quote $PSCommandPath) + ' -Mode Child -FixtureRoot ' + (Quote $FixtureRoot) + ' -Nonce ' + $Nonce
    if ($RunGates) { $arguments += ' -RunGates' }
    if ($PowerShell7Path) { $arguments += ' -PowerShell7Path ' + (Quote $shell) }
    # RDP already loaded this exact user's hive and stays alive until this child exits.
    $profileHive = [Microsoft.Win32.Registry]::Users.OpenSubKey($sid)
    try { if ($marker.phase -ne 'Installer' -or $null -eq $profileHive) { throw 'The isolated RDP installer profile is not loaded.' } }
    finally { if ($profileHive) { $profileHive.Dispose() } }
    $childDeadline = if ($RunGates) { [Math]::Max(0, [int](($gatesDeadline - [DateTime]::UtcNow).TotalMilliseconds)) } else { 60000 }
    if ($childDeadline -le 0) { throw 'The standard-user native gates exceeded their common deadline.' }
    $child = Start-Process -FilePath $shell -ArgumentList $arguments -Credential $credential -LoadUserProfile:$false -UseNewEnvironment -WorkingDirectory $FixtureRoot -RedirectStandardOutput (Join-Path $FixtureRoot 'stdout.log') -RedirectStandardError (Join-Path $FixtureRoot 'stderr.log') -PassThru
    $credential = $null; $password.Dispose(); $password = $null
    if ($RunGates) { $childDeadline = [Math]::Max(0, [int](($gatesDeadline - [DateTime]::UtcNow).TotalMilliseconds)) }
    if ($childDeadline -le 0) { throw 'The standard-user native gates exceeded their common deadline.' }
    if (-not $child.WaitForExit($childDeadline)) { throw 'Standard-user fixture child timed out.' }
    if (Test-Path -LiteralPath $resultPath) {
        $result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
        if ($result.nonce -ne $Nonce -or $result.sid -ne $sid -or $result.phase -ne 'Installer') { throw 'Invalid standard-user installer phase receipt.' }
        $result.PSObject.Properties.Remove('nonce'); $result.PSObject.Properties.Remove('sid')
        if ($child.ExitCode -ne 0 -or $result.selfElevated -ne $false) { $result.result = 'failed' }
        $result | Add-Member -NotePropertyName verifiedRdpSessionId -NotePropertyValue $rdp.SessionId
        $ownEvents = @()
        try {
            $ownTaskXPath = "*[EventData[Data[@Name='TaskName']='\Rele-CI-Canary-$Nonce']]"
            foreach ($event in @(Get-WinEvent -LogName $operationalLog -FilterXPath $ownTaskXPath -MaxEvents 32 -ErrorAction Stop)) {
                $record = @{ eventId = [int]$event.Id }
                $xml = [xml]$event.ToXml()
                foreach ($datum in @($xml.Event.EventData.Data)) {
                    if ([string]$datum.Name -in @('ErrorValue', 'ResultCode', 'HRESULT')) { $record[[string]$datum.Name] = [string]$datum.InnerText }
                }
                $ownEvents += $record
            }
        } catch { $result | Add-Member -NotePropertyName taskEventsErrorHResult -NotePropertyValue ('0x{0:X8}' -f $_.Exception.HResult) }
        $result | Add-Member -NotePropertyName taskEvents -NotePropertyValue $ownEvents
        if (@($ownEvents | Where-Object { $_.eventId -eq 332 }).Count -ne 0) {
            try {
                $template = [string]((Get-WinEvent -ListProvider 'Microsoft-Windows-TaskScheduler').Events | Where-Object { $_.Id -eq 332 } | Select-Object -First 1 -ExpandProperty Description)
                $result | Add-Member -NotePropertyName event332Template -NotePropertyValue $template.Substring(0, [Math]::Min(1024, $template.Length))
            } catch { $result | Add-Member -NotePropertyName event332TemplateErrorHResult -NotePropertyValue ('0x{0:X8}' -f $_.Exception.HResult) }
        }
        $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $resultPath -Encoding UTF8
        Get-Content -LiteralPath $resultPath -Raw | Write-Output
        Copy-Item -LiteralPath $resultPath -Destination (Join-Path $sourceRoot 'windows-standard-user-results.json')
    } else { throw 'The standard-user installer phase did not produce a receipt.' }
    if ($result.result -ne 'passed') { foreach ($log in @('stdout.log', 'stderr.log')) { Get-Content -LiteralPath (Join-Path $FixtureRoot $log) -Tail 30 | Write-Output }; throw 'The standard-user canary or native gate failed; see the bounded fixture reports.' }
} catch {
    $publishedResult = Join-Path $sourceRoot 'windows-standard-user-results.json'
    if (-not (Test-Path -LiteralPath $publishedResult)) {
        @{ result = 'failed'; stage = $parentStage; error = $_.Exception.Message; errorHResult = ('0x{0:X8}' -f $_.Exception.HResult) } | ConvertTo-Json | Set-Content -LiteralPath $publishedResult -Encoding UTF8
    }
    throw
} finally {
    if ($rdpStartedAt) {
        $rdpClientPid = [int]$rdp.Diagnostics['mstscPid']
        try {
            if ($rdpClientPid -le 0) { throw 'The owned RDP client process did not start.' }
            $connections = @(Get-CimInstance -Namespace 'root/StandardCimv2' -ClassName MSFT_NetTCPConnection -Filter ("OwningProcess = $rdpClientPid AND RemoteAddress = '127.0.0.1' AND RemotePort = 3389") -Property State -ErrorAction Stop)
            $rdpTransport.loopbackConnectionCount = $connections.Count; $rdpTransport.tcpStates = @($connections | ForEach-Object { [int]$_.State })
        } catch { $rdpTransport.tcpErrorHResult = ('0x{0:X8}' -f $_.Exception.HResult) }
        $rdpTransport.events = @()
        try {
            $since = $rdpStartedAt.ToString('yyyy-MM-ddTHH:mm:ss.fffffffZ')
            if ($rdpClientPid -le 0) { throw 'The owned RDP client process did not start.' }
            $xpath = "*[System[Execution[@ProcessID='$rdpClientPid'] and TimeCreated[@SystemTime>='$since']]]"
            foreach ($event in @(Get-WinEvent -LogName $rdpClientLog -FilterXPath $xpath -MaxEvents 32 -ErrorAction Stop)) {
                $record = @{ eventId = [int]$event.Id }; $xml = [xml]$event.ToXml()
                foreach ($datum in @($xml.Event.EventData.Data)) {
                    if ([string]$datum.Name -in @('ErrorCode', 'Error', 'Status', 'Result', 'ResultCode', 'HRESULT', 'DisconnectReason', 'ExtendedDisconnectReason', 'Reason', 'State') -and [string]$datum.InnerText -match '^(0[xX][0-9a-fA-F]{1,16}|-?[0-9]{1,20})$') { $record[[string]$datum.Name] = [string]$datum.InnerText }
                }
                $rdpTransport.events += $record
            }
        } catch { $rdpTransport.eventsErrorHResult = ('0x{0:X8}' -f $_.Exception.HResult) }
        try {
            $observed = @($rdpTransport.events | ForEach-Object { $_.eventId })
            $rdpTransport.eventTemplates = @((Get-WinEvent -ListProvider 'Microsoft-Windows-TerminalServices-ClientActiveXCore').Events | Where-Object { $_.Id -in @(1024, 1028, 1029, 1102, 1103) -and $_.Id -in $observed } | Sort-Object Id -Unique | Select-Object -First 5 | ForEach-Object { $description = [string]$_.Description; @{ eventId = [int]$_.Id; description = $description.Substring(0, [Math]::Min(512, $description.Length)) } })
        } catch { $rdpTransport.templateErrorHResult = ('0x{0:X8}' -f $_.Exception.HResult) }
        $rdpTransport.serverEvents = @()
        foreach ($server in @(
            @{ provider = 'Microsoft-Windows-TerminalServices-RemoteConnectionManager'; eventId = 1149; fields = @('Param1', 'Param2') },
            @{ provider = 'Microsoft-Windows-TerminalServices-LocalSessionManager'; eventId = 21; fields = @('User', 'SessionID') }
        )) {
            $record = @{ eventId = $server.eventId; events = @(); schemaVerified = 0 }
            $rdpTransport.serverEvents += $record
            try {
                $log = $server.provider + '/Operational'; $provider = Get-WinEvent -ListProvider $server.provider
                $metadata = @($provider.Events | Where-Object { $_.Id -eq $server.eventId } | Select-Object -First 1)
                if (@($provider.LogLinks | Where-Object { $_.LogName -eq $log }).Count -ne 1 -or $metadata.Count -ne 1 -or $metadata[0].LogLink.LogName -ne $log) { throw 'The fixed RDP server event channel is unavailable.' }
                $template = [xml]$metadata[0].Template
                foreach ($field in $server.fields) {
                    $type = if ($field -eq 'SessionID') { 'win:UInt32' } else { 'win:UnicodeString' }
                    if (-not $template.SelectSingleNode("//*[local-name()='data' and @name='$field' and @inType='$type']")) { throw 'The inbox RDP server event schema is unsupported.' }
                }
                $record.schemaVerified = 1; $record.logEnabled = [int](Get-WinEvent -ListLog $log).IsEnabled
                if (-not $record.logEnabled) { continue }
                $identity = [Environment]::MachineName + '\' + $account
                $owner = if ($server.eventId -eq 1149) { "Param1='$account' and (Param2='$([Environment]::MachineName)' or Param2='.')" } else { "User='$identity'" }
                $xpath = "*[System[EventID=$($server.eventId) and TimeCreated[@SystemTime>='$since']] and UserData[EventXML[$owner]]]"
                foreach ($event in @(Get-WinEvent -LogName $log -FilterXPath $xpath -MaxEvents 16 -ErrorAction Stop)) {
                    $xml = [xml]$event.ToXml(); $data = $xml.SelectSingleNode("//*[local-name()='UserData']/*[local-name()='EventXML']")
                    foreach ($field in $server.fields) { if (-not $data -or -not $data.SelectSingleNode("*[local-name()='$field']")) { throw 'The RDP server event payload is unsupported.' } }
                    if ($server.eventId -eq 1149) { if ([string]$data.Param1 -ne $account -or [string]$data.Param2 -notin @([Environment]::MachineName, '.')) { continue } }
                    elseif ([string]$data.User -ne $identity) { continue }
                    $item = @{ eventId = [int]$event.Id }
                    if ($server.eventId -eq 21 -and [string]$data.SessionID -match '^[0-9]{1,10}$') { $item.sessionId = [long][string]$data.SessionID }
                    $record.events += $item
                }
            } catch {
                if ($_.FullyQualifiedErrorId -eq 'NoMatchingEventsFound,Microsoft.PowerShell.Commands.GetWinEventCommand') { $record.noMatchingEvents = 1 }
                else { $record.errorHResult = ('0x{0:X8}' -f $_.Exception.HResult) }
            }
        }
        $rdpTransport.logonEvents = @()
        try {
            $xpath = "*[System[(EventID=4624 or EventID=4625) and TimeCreated[@SystemTime>='$since']] and EventData[Data[@Name='TargetUserSid']='$sid' or Data[@Name='TargetUserName']='$account']]"
            foreach ($event in @(Get-WinEvent -LogName Security -FilterXPath $xpath -MaxEvents 32 -ErrorAction Stop)) {
                $values = @{}; $xml = [xml]$event.ToXml()
                foreach ($datum in @($xml.Event.EventData.Data)) { $values[[string]$datum.Name] = [string]$datum.InnerText }
                if ($values.TargetUserSid -ne $sid -and ($values.TargetUserName -ne $account -or $values.TargetDomainName -notin @([Environment]::MachineName, '.'))) { continue }
                $record = @{ eventId = [int]$event.Id }
                foreach ($name in @('LogonType', 'Status', 'SubStatus')) { if ($values[$name] -match '^(0[xX][0-9a-fA-F]{1,8}|[0-9]{1,10})$') { $record[$name] = $values[$name] } }
                if ($values.AuthenticationPackageName -in @('NTLM', 'Kerberos', 'Negotiate')) { $record.authenticationPackage = $values.AuthenticationPackageName }
                $rdpTransport.logonEvents += $record
            }
        } catch {
            if ($_.FullyQualifiedErrorId -eq 'NoMatchingEventsFound,Microsoft.PowerShell.Commands.GetWinEventCommand') { $rdpTransport.logonNoMatchingEvents = $true }
            else { $rdpTransport.logonEventsErrorHResult = ('0x{0:X8}' -f $_.Exception.HResult) }
        }
    }
    $credential = $null; if ($password) { $password.Dispose() }
    $cleanupFailures = @()
    $profileCleanupFacts = @{}
    $installerProgress = [Collections.Generic.List[string]]::new()
    $cleanupStep = 0
    foreach ($action in @(
        { if ($child) { if (-not $child.HasExited) { Stop-Process -Id $child.Id -Force }; if (-not $child.WaitForExit(5000)) { throw 'The owned fixture child did not exit.' }; $child.Dispose() } },
        { if ($rdp) { $rdp.Dispose() } },
        { if ($rdpSettingsChanged) { if ($null -eq $priorDeny) { Remove-ItemProperty -LiteralPath $terminalPath -Name fDenyTSConnections } else { Set-ItemProperty -LiteralPath $terminalPath -Name fDenyTSConnections -Value $priorDeny } } },
        { if ($redirectorStarted) { Stop-Service -Name UmRdpService } },
        { if ($redirectorStartupChanged) { Set-Service -Name UmRdpService -StartupType $priorRedirectorStartup } },
        { if ($serviceStarted) { Stop-Service -Name TermService } },
        { if ($serviceStartupChanged) { Set-Service -Name TermService -StartupType $priorServiceStartup } },
        { if ($user -and $Phase -eq 'Installer') { Remove-Canary $user.SID.Value } },
        { if ($user) { Remove-FixtureProfile $user.SID.Value $profileCleanupFacts } },
        { if ($user) { Remove-LocalUser -SID $user.SID } },
        { if ($RunGates) {
            foreach ($name in @('installer-results.json', 'installer-failure-results.json', 'installer-native-cleanup-results.json', 'shared-results-0.163.0.json', 'shared-results-0.163.0-alpha.10.2.json', 'shared-results-0.163.0-alpha.11.json', 'shared-results-actual-desktop.json')) { $report = Join-Path $FixtureRoot ('reports\' + $name); if (Test-Path -LiteralPath $report) { Copy-Item -LiteralPath $report -Destination (Join-Path $sourceRoot $name) } }
            $stdout = Join-Path $FixtureRoot 'stdout.log'
            if (Test-Path -LiteralPath $stdout) {
                $allowed = @('Windows installer smoke: an unknown startup script is preserved', 'Windows installer smoke: a previous portable process is not killed', 'Windows installer smoke: foreign Desktop settings are preserved without blocking installation', 'Windows installer smoke: the Codex wrapper preserves argv, profile, data and raw bytes', 'Windows installer smoke: launcher restart', 'Windows installer smoke: same-version upgrade with backup', 'Windows installer smoke: owned Desktop settings restore and later foreign changes survive uninstall', 'Windows installer smoke: uninstall preserves data', 'Windows installer cleanup: desktop-environment', 'Windows installer cleanup: held-adapter', 'Windows installer cleanup: native-daemon', 'Windows installer cleanup: files', 'Windows installer cleanup: complete')
                Get-Content -LiteralPath $stdout -Tail 64 | Where-Object { $_ -in $allowed } | Select-Object -Last 32 | ForEach-Object { $installerProgress.Add([string]$_) }
            }
        } },
        { Remove-Item -LiteralPath $FixtureRoot -Recurse -Force }
    )) {
        $stepName = @('child', 'rdp-session', 'rdp-setting', 'redirector-stop', 'redirector-startup', 'service-stop', 'service-startup', 'task', 'profile', 'user', 'reports', 'fixture')[$cleanupStep++]
        try { & $action } catch { $message = $_.Exception.Message; $cleanupFailures += @{ step = $stepName; hresult = ('0x{0:X8}' -f $_.Exception.HResult); message = $message.Substring(0, [Math]::Min(512, $message.Length)) } }
    }
    $publishedResult = Join-Path $sourceRoot 'windows-standard-user-results.json'
    if (Test-Path -LiteralPath $publishedResult) {
        $result = Get-Content -LiteralPath $publishedResult -Raw | ConvertFrom-Json
        if ($sharedOutcome) { $result | Add-Member -Force -NotePropertyName sharedPhase -NotePropertyValue $sharedOutcome }
        if ($rdp) { $result | Add-Member -Force -NotePropertyName rdpDiagnostics -NotePropertyValue $rdp.Diagnostics }
        if ($rdp) { $result | Add-Member -NotePropertyName rdpWindows -NotePropertyValue ($rdp.MstscWindows.ToArray()) }
        if ($rdpStartedAt) { $result | Add-Member -NotePropertyName rdpClient -NotePropertyValue 'mstsc' }
        $result | Add-Member -NotePropertyName rdpTransport -NotePropertyValue $rdpTransport
        $result | Add-Member -NotePropertyName rdpModeBefore -NotePropertyValue $rdpModeBefore
        $result | Add-Member -NotePropertyName rdpModeAfter -NotePropertyValue $rdpModeAfter
        if ($profileCleanupFacts.Count -ne 0) { $result | Add-Member -NotePropertyName profileCleanup -NotePropertyValue $profileCleanupFacts }
        if ($installerProgress.Count -ne 0) { $result | Add-Member -NotePropertyName installerProgress -NotePropertyValue ($installerProgress.ToArray()) }
        if ($cleanupFailures.Count -ne 0) { $result.result = 'failed'; $result | Add-Member -NotePropertyName cleanupErrors -NotePropertyValue $cleanupFailures }
        $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $publishedResult -Encoding UTF8
    }
    if ($cleanupFailures.Count -ne 0) { throw 'The isolated Windows canary cleanup did not complete.' }
}
