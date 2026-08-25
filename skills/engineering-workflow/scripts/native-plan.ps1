param(
    [Parameter(Mandatory = $true)]
    [string]$StatePath,
    [string]$MappingPath,
    [string]$PolicyPath,
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
try {
    if ([string]::IsNullOrWhiteSpace($MappingPath)) { $MappingPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'references\native-plan.json' }
    if ([string]::IsNullOrWhiteSpace($PolicyPath)) { $PolicyPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'references\state-machine.json' }
    $state = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
    $mapping = Get-Content -LiteralPath $MappingPath -Raw | ConvertFrom-Json
    $policy = Get-Content -LiteralPath $PolicyPath -Raw | ConvertFrom-Json
    foreach ($field in @('flow', 'status', 'current_phase', 'next_phase', 'plan_target', 'terminal_condition', 'resume_point')) {
        if (-not $state.PSObject.Properties[$field] -or [string]::IsNullOrWhiteSpace([string]$state.$field)) {
            throw "Workflow state is missing: $field"
        }
    }
    $phaseDescription = $mapping.phase_mapping.PSObject.Properties[[string]$state.current_phase]
    if (-not $phaseDescription) { throw "No native Plan mapping exists for phase: $($state.current_phase)" }
    $skipped = @()
    if ($state.route -and $state.route.skipped_phases) { $skipped = @($state.route.skipped_phases) }
    $index = [array]::IndexOf(@($policy.phase_order), [string]$state.current_phase)
    if ($index -lt 0) { throw "No phase order entry exists for: $($state.current_phase)" }
    $phases = @($policy.phase_order | Select-Object -Skip $index | Where-Object { $_ -eq $state.current_phase -or $_ -eq $state.next_phase -or $_ -notin $skipped } | Select-Object -Unique)
    $steps = @()
    foreach ($phase in $phases) {
        $description = $mapping.phase_mapping.PSObject.Properties[[string]$phase]
        if (-not $description) { throw "No native Plan mapping exists for phase: $phase" }
        $steps += [ordered]@{ id = [string]$phase; title = [string]$description.Value; status = if ($state.status -eq 'complete' -and $phase -eq 'close') { 'completed' } elseif ($phase -eq $state.current_phase) { 'in_progress' } else { 'pending' } }
    }
    $payload = [ordered]@{
        schema_version = [string]$mapping.schema_version
        authority = [string]$mapping.authority
        scope = [string]$mapping.scope
        projection_scope = [string]$mapping.projection_scope
        handshake = @($mapping.handshake)
        workflow = [ordered]@{ flow = [string]$state.flow; status = [string]$state.status; current_phase = [string]$state.current_phase; next_phase = [string]$state.next_phase; plan_target = [string]$state.plan_target; terminal_condition = [string]$state.terminal_condition; resume_point = [string]$state.resume_point }
        steps = $steps
        generated_at_utc = [DateTime]::UtcNow.ToString('o')
    }
    $json = $payload | ConvertTo-Json -Depth 8
    if ($OutputPath) {
        $parent = Split-Path $OutputPath -Parent
        if ($parent -and -not (Test-Path -LiteralPath $parent -PathType Container)) { [void][IO.Directory]::CreateDirectory($parent) }
        [IO.File]::WriteAllText($OutputPath, $json + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
    }
    $json
    exit 0
} catch {
    Write-Output "FATAL: $($_.Exception.Message)"
    exit 1
}
