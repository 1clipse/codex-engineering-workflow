param(
    [Parameter(Mandatory = $true)]
    [string]$RecordPath,
    [string]$SchemaPath,
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
try {
    if ([string]::IsNullOrWhiteSpace($SchemaPath)) { $SchemaPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'references\route-record.json' }
    $record = Get-Content -LiteralPath $RecordPath -Raw | ConvertFrom-Json
    $schema = Get-Content -LiteralPath $SchemaPath -Raw | ConvertFrom-Json
    foreach ($field in @($schema.required_fields)) {
        if (-not $record.PSObject.Properties[$field] -or $null -eq $record.$field) { throw "Route record is missing: $field" }
    }
    if ($record.confidence -notin @($schema.confidence_values)) { throw "Unknown route confidence: $($record.confidence)" }
    $serialized = $record | ConvertTo-Json -Compress -Depth 8
    if ($serialized -match '(?i)(sk-[A-Za-z0-9_-]{12,}|bearer\s+[A-Za-z0-9._-]{12,}|api[_-]?key\s*[:=])') { throw 'Route record appears to contain a credential or secret.' }
    if ($OutputPath) { [IO.File]::WriteAllText($OutputPath, ($record | ConvertTo-Json -Depth 8) + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false))) }
    if ($record.confidence -eq 'low') { Write-Output 'ACTION: request the smallest user route choice before execution.' }
    $record | ConvertTo-Json -Depth 8
    exit 0
} catch {
    Write-Output "FATAL: $($_.Exception.Message)"
    exit 1
}
