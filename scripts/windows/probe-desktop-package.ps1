[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if ($env:GITHUB_ACTIONS -ne 'true' -or $env:OS -ne 'Windows_NT' -or -not $env:RUNNER_TEMP) {
    throw 'Run this download/inventory probe only on a disposable GitHub Windows runner.'
}
$root = [IO.Path]::GetFullPath($OutputDirectory)
$temporaryRoot = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'
if (-not $root.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $root)) {
    throw 'OutputDirectory must be a new directory under RUNNER_TEMP.'
}
$null = New-Item -ItemType Directory -Path $root
$downloads = Join-Path $root 'downloads'
$payload = Join-Path $root 'payload'
$null = New-Item -ItemType Directory -Path $downloads, $payload
$timer = [Diagnostics.Stopwatch]::StartNew()
$url = 'https://persistent.oaistatic.com/codex-app-prod/ChatGPT-x64.msix'
$report = [ordered]@{
    result = 'failed'; stage = 'download'; elapsedMs = 0
    productId = '9PLM9XGG6VKS'; officialUrl = $url; acquisition = $null
    downloadAttempts = @(); package = $null; dependencies = @(); inventory = @()
    requiredBasenamesPresent = [ordered]@{}
    declaredGuiExecutables = @(); manifestGuiExecutablePresent = $false; desktopAsarPresent = $false
    actualDesktopBundle = $false; actualDesktopGui = $false
    codexOrAppExecuted = $false; appxInstalled = $false; userProfileRead = $false
    productAcceptance = $false
}
$failureCode = 'download-failed'
$exitCode = 1

try {
    $package = Join-Path $downloads 'ChatGPT-x64.msix'
    try {
        $null = Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $package -TimeoutSec 90
        $report.downloadAttempts += [ordered]@{ method = 'official-msix'; success = $true }
        $report.acquisition = 'official-msix'
    } catch {
        $status = $null
        $responseProperty = $_.Exception.PSObject.Properties['Response']
        if ($responseProperty -and $responseProperty.Value) { $status = [int]$responseProperty.Value.StatusCode }
        $report.downloadAttempts += [ordered]@{ method = 'official-msix'; success = $false; httpStatus = $status }
        Remove-Item -LiteralPath $package -Force -ErrorAction SilentlyContinue
    }

    if (-not $report.acquisition) {
        $report.stage = 'winget-download'
        $winget = Get-Command winget.exe -CommandType Application -ErrorAction SilentlyContinue
        $failureCode = 'winget-unavailable'
        if (-not $winget) { throw 'WinGet is unavailable; no installer or framework chain will be installed.' }
        $stdout = Join-Path $root 'winget-stdout.tmp'
        $stderr = Join-Path $root 'winget-stderr.tmp'
        $arguments = 'download --id 9PLM9XGG6VKS --source msstore --exact --skip-license --skip-dependencies --architecture x64 --platform Windows.Desktop --accept-source-agreements --accept-package-agreements --disable-interactivity --download-directory "' + $downloads + '"'
        $process = $null
        $failureCode = 'winget-download-failed'
        try {
            $process = Start-Process -FilePath $winget.Source -ArgumentList $arguments -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
            if (-not $process.WaitForExit(180000)) {
                $failureCode = 'winget-download-timeout'
                $process.Kill()
                $null = $process.WaitForExit(5000)
                throw 'The owned WinGet download exceeded its deadline.'
            }
            $code = $process.ExitCode
            $report.downloadAttempts += [ordered]@{ method = 'winget-msstore'; success = ($code -eq 0); exitCode = $code }
            if ($code -ne 0) { throw 'WinGet could not download the package without interaction.' }
        } finally {
            if ($process) { $process.Dispose() }
            Remove-Item -LiteralPath $stdout, $stderr -Force -ErrorAction SilentlyContinue
        }
        $files = @(Get-ChildItem -LiteralPath $downloads -File -Recurse | Where-Object { $_.Extension -in '.msix', '.appx' })
        $failureCode = 'ambiguous-or-unsupported-store-payload'
        if ($files.Count -ne 1) { throw 'Expected one x64 MSIX/AppX; bundles and dependency installation are outside this inventory probe.' }
        $package = $files[0].FullName
        $report.acquisition = 'winget-msstore'
    }

    $report.stage = 'signature'
    $failureCode = 'package-signature-not-valid'
    $signature = Get-AuthenticodeSignature -LiteralPath $package
    $report.package = [ordered]@{
        fileName = [IO.Path]::GetFileName($package); size = (Get-Item -LiteralPath $package).Length
        sha256 = (Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash.ToLowerInvariant()
        signature = [ordered]@{
            status = [string]$signature.Status
            signerSubject = $(if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null })
            signerThumbprint = $(if ($signature.SignerCertificate) { $signature.SignerCertificate.Thumbprint } else { $null })
        }
        identity = $null
    }
    if ($signature.Status -ne 'Valid') { throw 'The downloaded package signature is not trusted.' }

    $report.stage = 'manifest'
    $failureCode = 'invalid-desktop-package'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($package)
    try {
        $manifestEntry = $archive.GetEntry('AppxManifest.xml')
        if (-not $manifestEntry) { throw 'AppxManifest.xml is absent.' }
        $settings = [Xml.XmlReaderSettings]::new()
        $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
        $settings.MaxCharactersInDocument = 1024 * 1024
        $settings.XmlResolver = $null
        $stream = $manifestEntry.Open()
        $reader = [Xml.XmlReader]::Create($stream, $settings)
        try {
            $manifest = [Xml.XmlDocument]::new()
            $manifest.XmlResolver = $null
            $manifest.Load($reader)
        } finally { $reader.Dispose(); $stream.Dispose() }
        $identity = $manifest.SelectSingleNode("/*[local-name()='Package']/*[local-name()='Identity']")
        if (-not $identity) { throw 'The package identity is absent.' }
        $report.package.identity = [ordered]@{
            name = $identity.GetAttribute('Name'); version = $identity.GetAttribute('Version')
            publisher = $identity.GetAttribute('Publisher'); architecture = $identity.GetAttribute('ProcessorArchitecture')
        }
        if ($report.package.identity.name -notin @('OpenAI.Codex', 'OpenAI.ChatGPT') -or $report.package.identity.architecture -ne 'x64') {
            throw 'The signed package is not an expected OpenAI Desktop x64 application.'
        }
        $report.dependencies = @($manifest.SelectNodes("/*[local-name()='Package']/*[local-name()='Dependencies']/*") | ForEach-Object {
            [ordered]@{ type = $_.LocalName; name = $_.GetAttribute('Name'); publisher = $_.GetAttribute('Publisher'); minVersion = $_.GetAttribute('MinVersion') }
        })
        $guiExecutables = @($manifest.SelectNodes("/*[local-name()='Package']/*[local-name()='Applications']/*[local-name()='Application']") | ForEach-Object {
            $_.GetAttribute('Executable').Replace('\', '/')
        } | Where-Object { $_ })
        $report.declaredGuiExecutables = $guiExecutables
        if (-not $guiExecutables.Count) { throw 'The signed package does not declare a Desktop application.' }
        $required = @('codex.exe', 'codex-code-mode-host.exe', 'codex-command-runner.exe', 'codex-windows-sandbox-setup.exe', 'rg.exe', 'codex-package.json')
        $report.stage = 'inventory'
        $failureCode = 'package-inventory-failed'
        foreach ($entry in @($archive.Entries | Sort-Object FullName)) {
            $relative = $entry.FullName.Replace('\', '/')
            $leaf = [IO.Path]::GetFileName($relative)
            $isGui = $relative -in $guiExecutables
            $isAsar = $relative -match '(^|/)resources/app\.asar$'
            if ($leaf -notin $required -and -not $isGui -and -not $isAsar) { continue }
            if ($relative -match '(^/|:|(^|/)\.\.(/|$))') { throw 'An inventory entry is not a safe relative path.' }
            $row = [ordered]@{
                path = $relative; size = $entry.Length; role = $(if ($isGui) { 'gui' } elseif ($isAsar) { 'desktop-asar' } else { 'backend-or-helper' })
                sha256 = $null; fileVersion = $null; productVersion = $null; packageVersion = $null
            }
            if (-not $isAsar) {
                $destination = Join-Path $payload $relative.Replace('/', '\')
                $null = New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($destination))
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $false)
                $row.sha256 = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
                if ([IO.Path]::GetExtension($leaf) -ieq '.exe') {
                    $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($destination)
                    $row.fileVersion = $version.FileVersion
                    $row.productVersion = $version.ProductVersion
                } elseif ($leaf -ieq 'codex-package.json') {
                    $metadata = Get-Content -LiteralPath $destination -Raw | ConvertFrom-Json
                    if ($metadata.PSObject.Properties.Name -contains 'version') { $row.packageVersion = [string]$metadata.version }
                }
            }
            $report.inventory += $row
        }
        foreach ($name in $required) {
            $report.requiredBasenamesPresent[$name] = @($report.inventory | Where-Object {
                [IO.Path]::GetFileName($_.path) -ieq $name -and $_.role -ne 'gui'
            }).Count -gt 0
        }
        $report.manifestGuiExecutablePresent = @($report.inventory | Where-Object { $_.role -eq 'gui' }).Count -gt 0
        $report.desktopAsarPresent = @($report.inventory | Where-Object { $_.role -eq 'desktop-asar' }).Count -gt 0
        $report.actualDesktopBundle = $true
        $report.result = 'passed'
        $report.stage = 'complete'
        $exitCode = 0
    } finally { $archive.Dispose() }
} catch {
    $report['failureCode'] = $failureCode
    $report['exceptionType'] = $_.Exception.GetType().FullName
} finally {
    $report.elapsedMs = $timer.ElapsedMilliseconds
    $json = $report | ConvertTo-Json -Depth 10
    $output = [IO.File]::Open((Join-Path $root 'desktop-package-inventory.json'), [IO.FileMode]::CreateNew)
    $writer = [IO.StreamWriter]::new($output, [Text.UTF8Encoding]::new($false))
    try { $writer.WriteLine($json) } finally { $writer.Dispose() }
    Write-Output $json
}
exit $exitCode
