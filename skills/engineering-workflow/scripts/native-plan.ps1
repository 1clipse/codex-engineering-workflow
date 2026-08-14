param(
    [Parameter(Mandatory = $true)]
    [string]$StatePath,
    [string]$MappingPath,
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
try {
    if ([string]::IsNullOrWhiteSpace($MappingPath)) { $MappingPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'references\native-plan.json' }
    $state = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
    $mapping = Get-Content -LiteralPath $MappingPath -Raw | ConvertFrom-Json
    foreach ($field in @('flow', 'status', 'current_phase', 'next_phase', 'plan_target', 'terminal_condition', 'resume_point')) {
        if (-not $state.PSObject.Properties[$field] -or [string]::IsNullOrWhiteSpace([string]$state.$field)) {
            throw "Workflow state is missing: $field"
        }
    }
    $phaseDescription = $mapping.phase_mapping.PSObject.Properties[[string]$state.current_phase]
    if (-not $phaseDescription) { throw "No native Plan mapping exists for phase: $($state.current_phase)" }
    $steps = @(
        [ordered]@{ id = 'current'; title = [string]$phaseDescription.Value; status = if ($state.status -eq 'complete') { 'completed' } else { 'in_progress' } },
        [ordered]@{ id = 'next'; title = if ($state.next_phase -eq 'none') { 'No next phase' } else { [string]$mapping.phase_mapping.PSObject.Properties[[string]$state.next_phase].Value }; status = 'pending' }
    )
    $payload = [ordered]@{
        schema_version = [string]$mapping.schema_version
        authority = [string]$mapping.authority
        scope = [string]$mapping.scope
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
