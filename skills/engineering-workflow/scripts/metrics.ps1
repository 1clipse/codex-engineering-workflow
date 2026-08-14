param(
    [Parameter(Mandatory = $true)]
    [string]$LogPath,
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
try {
    if (-not (Test-Path -LiteralPath $LogPath -PathType Leaf)) { throw "Transition log is missing: $LogPath" }
    $records = @()
    foreach ($line in Get-Content -LiteralPath $LogPath) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try { $records += ($line | ConvertFrom-Json) } catch { continue }
    }
    $phaseTimes = [ordered]@{}
    $routeCount = 0
    $clarificationRounds = 0
    $blockedCount = 0
    $partialCount = 0
    $failedCount = 0
    $rerouteCount = 0
    $completionEvidenceMissingCount = 0
    $lastByRun = @{}
    foreach ($record in $records) {
        if ($record.event -eq 'route-selected') { $routeCount++ }
        if ($record.current_phase -eq 'clarify') { $clarificationRounds++ }
        if ($record.status -in @('awaiting-user', 'blocked-external')) { $blockedCount++ }
        if ($record.status -eq 'partial') { $partialCount++ }
        if ($record.status -eq 'failed') { $failedCount++ }
        if ($record.event -in @('scope-change', 'user-resumed')) { $rerouteCount++ }
        if ($record.event -eq 'completion-evidence-missing') { $completionEvidenceMissingCount++ }
        $run = [string]$record.run_id
        if ($run -and $lastByRun.ContainsKey($run)) {
            try {
                $previous = [datetime]$lastByRun[$run].timestamp_utc
                $current = [datetime]$record.timestamp_utc
                $seconds = ($current - $previous).TotalSeconds
                if ($seconds -ge 0 -and $seconds -lt 604800) {
                    if (-not $phaseTimes.Contains($lastByRun[$run].current_phase)) { $phaseTimes[$lastByRun[$run].current_phase] = 0.0 }
                    $phaseTimes[$lastByRun[$run].current_phase] = [math]::Round(([double]$phaseTimes[$lastByRun[$run].current_phase] + $seconds), 2)
                }
            } catch { }
        }
        if ($run) { $lastByRun[$run] = $record }
    }
    $metrics = [ordered]@{
        schema_version = '1.0.0'
        generated_at_utc = [datetime]::UtcNow.ToString('o')
        record_count = $records.Count
        route_count = $routeCount
        clarification_rounds = $clarificationRounds
        blocked_count = $blockedCount
        partial_count = $partialCount
        failed_count = $failedCount
        reroute_count = $rerouteCount
        completion_evidence_missing_count = $completionEvidenceMissingCount
        time_in_each_phase_seconds = $phaseTimes
        privacy = 'Aggregated metadata only; malformed lines and raw sensitive content are excluded.'
    }
    $json = $metrics | ConvertTo-Json -Depth 8
    if ($OutputPath) { [IO.File]::WriteAllText($OutputPath, $json + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false))) }
    $json
    exit 0
} catch {
    Write-Output "FATAL: $($_.Exception.Message)"
    exit 1
}
