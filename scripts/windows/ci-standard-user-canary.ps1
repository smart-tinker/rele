param([ValidateSet('Parent', 'Child')][string]$Mode = 'Parent', [string]$FixtureRoot, [string]$Nonce)
$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$shell = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'PowerShell\7\pwsh.exe'
if (-not (Test-Path -LiteralPath $shell) -or [Diagnostics.FileVersionInfo]::GetVersionInfo($shell).FileMajorPart -ne 7) { throw 'The trusted PowerShell 7 installation is required for this CI canary.' }
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
    $arguments = '--canary ' + (Quote $FixtureRoot) + ' ' + $Nonce + ' ' + $Sid
    if ($owner -ne $Sid -or $definition.Actions.Count -ne 1 -or $definition.Actions.Item(1).Path -ne (Join-Path $FixtureRoot 'FixtureElevation.exe') -or $definition.Actions.Item(1).Arguments -ne $arguments) { throw 'Refusing to remove a foreign canary task.' }
    try { $task.Stop(0) } catch { }
    $folder.DeleteTask($name, 0)
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
    $evidence = @{ result = 'failed'; selfElevated = $null; taskElevated = $null; stage = 'token'; selfSessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId }
    $task = $null; $running = $null
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
        $evidence.taskElevated = $receipt.elevated; $evidence.taskSessionId = $receipt.sessionId; $evidence.result = 'passed'; $evidence.stage = 'complete'
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
        try { Remove-Canary $sid } catch { $evidence.cleanupError = $_.Exception.Message; $evidence.result = 'failed' }
        $evidence | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $FixtureRoot 'windows-standard-user-results.json') -Encoding UTF8
    }
    if ($evidence.result -ne 'passed') { throw $evidence.error }
    exit 0
}

if ($env:GITHUB_ACTIONS -ne 'true' -or $env:CI -ne 'true' -or $env:RUNNER_OS -ne 'Windows') { throw 'Run this canary only on a disposable GitHub Windows runner.' }
$Nonce = [Guid]::NewGuid().ToString('N'); $account = 'ReleCi' + $Nonce.Substring(0, 8)
$operationalLog = 'Microsoft-Windows-TaskScheduler/Operational'
& (Join-Path ([Environment]::GetFolderPath('System')) 'wevtutil.exe') sl $operationalLog /e:true
if ($LASTEXITCODE -ne 0) { throw 'Cannot enable the disposable runner Task Scheduler diagnostic channel.' }
$FixtureRoot = Join-Path ([IO.Path]::GetPathRoot($env:RUNNER_TEMP)) ('rc-' + $Nonce.Substring(0, 8))
if (Test-Path -LiteralPath $FixtureRoot) { throw 'Fixture directory already exists.' }
New-Item -ItemType Directory -Path $FixtureRoot | Out-Null
$user = $null; $child = $null; $credential = $null; $password = $null; $rdp = $null
$rdpSettingsChanged = $false; $serviceStartupChanged = $false; $serviceStarted = $false
$terminalPath = 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server'
try {
    $bytes = New-Object byte[] 32; $random = [Security.Cryptography.RandomNumberGenerator]::Create(); $random.GetBytes($bytes); $random.Dispose()
    $password = ConvertTo-SecureString ('Aa1!' + [Convert]::ToBase64String($bytes)) -AsPlainText -Force; [Array]::Clear($bytes, 0, $bytes.Length)
    $user = New-LocalUser -Name $account -Password $password -AccountNeverExpires -PasswordNeverExpires -Description 'Disposable Rele native CI fixture'
    $sid = $user.SID.Value
    if (@(Get-LocalGroupMember -SID 'S-1-5-32-545' | Where-Object { $_.SID.Value -eq $sid }).Count -eq 0) { Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $account }
    if (@(Get-LocalGroupMember -SID 'S-1-5-32-544' | Where-Object { $_.SID.Value -eq $sid }).Count -ne 0) { throw 'Fixture user must not be an administrator.' }
    Add-LocalGroupMember -SID 'S-1-5-32-555' -Member $account
    & icacls.exe $sourceRoot /grant ('*' + $sid + ':(OI)(CI)(RX)') /T /C | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot grant fixture source read access.' }
    & icacls.exe $FixtureRoot /grant ('*' + $sid + ':(OI)(CI)(M)') /T /C | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot grant fixture write access.' }
    @{ nonce = $Nonce; sid = $sid } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $FixtureRoot 'parent.json') -Encoding UTF8
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    $rdpAssembly = Join-Path $FixtureRoot 'FixtureRdpSession.dll'
    & $compiler /nologo /target:library /platform:x64 /codepage:65001 /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:Microsoft.CSharp.dll ('/out:' + $rdpAssembly) (Join-Path $PSScriptRoot 'FixtureRdpSession.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Loopback RDP fixture helper compilation failed.' }
    [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($rdpAssembly)) | Out-Null
    Remove-Item -LiteralPath $rdpAssembly
    $priorDeny = (Get-Item -LiteralPath $terminalPath).GetValue('fDenyTSConnections', $null)
    if ($null -eq $priorDeny -or $priorDeny -ne 0) { Set-ItemProperty -LiteralPath $terminalPath -Name fDenyTSConnections -Value 0; $rdpSettingsChanged = $true }
    $service = Get-Service -Name TermService
    $priorServiceStartup = $service.StartType
    if ($priorServiceStartup -eq 'Disabled') { Set-Service -Name TermService -StartupType Manual; $serviceStartupChanged = $true }
    if ($service.Status -ne 'Running') { Start-Service -Name TermService; $serviceStarted = $true }
    $listenerDeadline = [DateTime]::UtcNow.AddSeconds(10)
    while (-not (Get-NetTCPConnection -LocalPort 3389 -State Listen -ErrorAction SilentlyContinue)) {
        if ([DateTime]::UtcNow -ge $listenerDeadline) { throw 'The disposable runner RDP listener did not become ready.' }
        Start-Sleep -Milliseconds 100
    }
    $rdp = [FixtureRdpSession]::new($account, $env:COMPUTERNAME, $password, $sid)
    $rdp.Connect()
    @{ nonce = $Nonce; sid = $sid; rdpSessionId = $rdp.SessionId } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $FixtureRoot 'parent.json') -Encoding UTF8
    $credential = New-Object System.Management.Automation.PSCredential ($env:COMPUTERNAME + '\' + $account), $password
    $arguments = '-NoProfile -NonInteractive -File ' + (Quote $PSCommandPath) + ' -Mode Child -FixtureRoot ' + (Quote $FixtureRoot) + ' -Nonce ' + $Nonce
    $child = Start-Process -FilePath $shell -ArgumentList $arguments -Credential $credential -LoadUserProfile -UseNewEnvironment -WorkingDirectory $FixtureRoot -RedirectStandardOutput (Join-Path $FixtureRoot 'stdout.log') -RedirectStandardError (Join-Path $FixtureRoot 'stderr.log') -PassThru
    $credential = $null; $password.Dispose(); $password = $null
    if (-not $child.WaitForExit(60000)) { throw 'Standard-user canary child timed out.' }
    $resultPath = Join-Path $FixtureRoot 'windows-standard-user-results.json'
    if (Test-Path -LiteralPath $resultPath) {
        $result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
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
    }
    if ($child.ExitCode -ne 0) { foreach ($log in @('stdout.log', 'stderr.log')) { Get-Content -LiteralPath (Join-Path $FixtureRoot $log) -Tail 30 | Write-Output }; throw 'Standard-user InteractiveToken canary failed; native gates must not run in this environment.' }
} catch {
    $publishedResult = Join-Path $sourceRoot 'windows-standard-user-results.json'
    if (-not (Test-Path -LiteralPath $publishedResult)) { @{ result = 'failed'; stage = 'rdp-session'; error = $_.Exception.Message; errorHResult = ('0x{0:X8}' -f $_.Exception.HResult) } | ConvertTo-Json | Set-Content -LiteralPath $publishedResult -Encoding UTF8 }
    throw
} finally {
    $credential = $null; if ($password) { $password.Dispose() }
    $cleanupFailures = @()
    $cleanupStep = 0
    foreach ($action in @(
        { if ($child -and -not $child.HasExited) { Stop-Process -Id $child.Id -Force } },
        { if ($rdp) { $rdp.Dispose() } },
        { if ($rdpSettingsChanged) { if ($null -eq $priorDeny) { Remove-ItemProperty -LiteralPath $terminalPath -Name fDenyTSConnections } else { Set-ItemProperty -LiteralPath $terminalPath -Name fDenyTSConnections -Value $priorDeny } } },
        { if ($serviceStarted) { Stop-Service -Name TermService } },
        { if ($serviceStartupChanged) { Set-Service -Name TermService -StartupType $priorServiceStartup } },
        { if ($user) { Remove-Canary $user.SID.Value } },
        { if ($user) { Remove-LocalUser -SID $user.SID } },
        { if ($user) { Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $user.SID.Value } | Remove-CimInstance } },
        { Remove-Item -LiteralPath $FixtureRoot -Recurse -Force }
    )) {
        $stepName = @('child', 'rdp-session', 'rdp-setting', 'service-stop', 'service-startup', 'task', 'user', 'profile', 'fixture')[$cleanupStep++]
        try { & $action } catch { $message = $_.Exception.Message; $cleanupFailures += @{ step = $stepName; hresult = ('0x{0:X8}' -f $_.Exception.HResult); message = $message.Substring(0, [Math]::Min(512, $message.Length)) } }
    }
    $publishedResult = Join-Path $sourceRoot 'windows-standard-user-results.json'
    if (Test-Path -LiteralPath $publishedResult) {
        $result = Get-Content -LiteralPath $publishedResult -Raw | ConvertFrom-Json
        if ($rdp) { $result | Add-Member -Force -NotePropertyName rdpDiagnostics -NotePropertyValue $rdp.Diagnostics }
        if ($cleanupFailures.Count -ne 0) { $result.result = 'failed'; $result | Add-Member -NotePropertyName cleanupErrors -NotePropertyValue $cleanupFailures }
        $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $publishedResult -Encoding UTF8
    }
    if ($cleanupFailures.Count -ne 0) { throw 'The isolated Windows canary cleanup did not complete.' }
}
