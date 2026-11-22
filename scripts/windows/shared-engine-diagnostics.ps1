function Get-SafeEngineDriverDiagnostics {
    param([object[]]$Diagnostics)
    $classes = @('AbortError', 'CodexTransportError', 'Error', 'RangeError', 'SharedCodexError', 'TimeoutError', 'TypeError')
    $codes = @('invalid-shared-profile', 'invalid-shared-target', 'shared-cli-unavailable', 'shared-cli-unverified',
        'shared-control-migration-required', 'shared-daemon-invalid', 'shared-daemon-unavailable', 'shared-desktop-conflict',
        'shared-desktop-package-invalid', 'shared-owner-unknown', 'shared-package-incomplete', 'shared-profile-mismatch')
    $sources = @('desktop-process', 'desktop-install', 'path', 'standard')
    $results = @('native-entrypoint-rejected', 'candidate-resolution-failed', 'shared-cli-unavailable',
        'shared-cli-unverified', 'shared-desktop-package-invalid')
    $safe = [Collections.Generic.List[object]]::new()
    foreach ($diagnostic in @($Diagnostics | Select-Object -Last 4)) {
        if ($diagnostic.kind -eq 'codex-connect-error') {
            $safe.Add([ordered]@{
                kind = 'codex-connect-error'
                errorClass = if ($diagnostic.errorClass -in $classes) { [string]$diagnostic.errorClass } else { 'other' }
                errorCode = if ($diagnostic.errorCode -in $codes) { [string]$diagnostic.errorCode } else { 'other' }
            })
        } elseif ($diagnostic.kind -eq 'windows-desktop-candidates') {
            $candidates = [Collections.Generic.List[object]]::new()
            foreach ($candidate in @($diagnostic.candidates | Select-Object -First 8)) {
                if ($candidate.source -notin $sources -or $candidate.result -notin $results) { continue }
                $row = [ordered]@{ source = [string]$candidate.source }
                if ($candidate.version -is [string] -and $candidate.version.Length -le 96 -and $candidate.version -match '^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$') { $row.version = [string]$candidate.version }
                $row.result = [string]$candidate.result
                $candidates.Add($row)
            }
            $safe.Add([ordered]@{ kind = 'windows-desktop-candidates'; candidates = $candidates.ToArray() })
        }
    }
    return $safe.ToArray()
}
