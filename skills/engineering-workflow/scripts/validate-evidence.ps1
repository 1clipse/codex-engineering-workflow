param(
    [Parameter(Mandatory = $true)]
    [string]$EvidencePath,
    [string]$SchemaPath
)

$ErrorActionPreference = 'Stop'
$errors = New-Object System.Collections.Generic.List[string]

try {
    if ([string]::IsNullOrWhiteSpace($SchemaPath)) { $SchemaPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'references\evidence-schema.json' }
    if (-not (Test-Path -LiteralPath $EvidencePath -PathType Leaf)) { throw "Evidence file is missing: $EvidencePath" }
    if (-not (Test-Path -LiteralPath $SchemaPath -PathType Leaf)) { throw "Evidence schema is missing: $SchemaPath" }
    $evidence = Get-Content -LiteralPath $EvidencePath -Raw | ConvertFrom-Json
    $schema = Get-Content -LiteralPath $SchemaPath -Raw | ConvertFrom-Json
    $items = @($evidence)
    if ($items.Count -eq 0) { $errors.Add('Evidence must contain at least one record.') }
    foreach ($item in $items) {
        foreach ($field in @($schema.required_fields)) {
            $property = $item.PSObject.Properties[$field]
            if (-not $property -or [string]::IsNullOrWhiteSpace([string]$property.Value)) {
                $errors.Add("Evidence record is missing required field: $field")
            }
        }
        if ($item.result -notin @($schema.allowed_results)) { $errors.Add("Evidence record has invalid result: $($item.result)") }
        if (@($item.acceptance_ids).Count -eq 0) { $errors.Add('Evidence record acceptance_ids must not be empty.') }
        if ([string]$item.artifact_digest -notmatch '^sha256:[0-9a-f]{64}$') { $errors.Add('Evidence record artifact_digest has invalid format.') }
        try { [void][DateTimeOffset]::Parse([string]$item.observed_at) } catch { $errors.Add('Evidence record observed_at is not valid ISO-8601.') }
        $serialized = ($item | ConvertTo-Json -Compress -Depth 8)
        if ($serialized -match '(?i)(sk-[A-Za-z0-9_-]{12,}|bearer\s+[A-Za-z0-9._-]{12,}|api[_-]?key\s*[:=])') {
            $errors.Add('Evidence record appears to contain a credential or secret.')
        }
    }
    if ($errors.Count -gt 0) {
        foreach ($message in $errors) { Write-Output "FATAL: $message" }
        Write-Output "FAIL: $($errors.Count) evidence issue(s)."
        exit 1
    }
    Write-Output "PASS: $($items.Count) structured evidence record(s) validated."
    exit 0
} catch {
    Write-Output "FATAL: $($_.Exception.Message)"
    Write-Output 'FAIL: evidence validation could not run.'
    exit 1
}
