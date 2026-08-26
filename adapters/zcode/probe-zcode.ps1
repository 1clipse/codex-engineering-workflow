$ErrorActionPreference = 'Stop'
$command = Get-Command zcode -ErrorAction SilentlyContinue
if (-not $command) {
    Write-Output 'ZCode capability: unavailable (zcode command was not found).'
    exit 2
}

$help = @(& $command.Source --help 2>&1) -join "`n"
$capabilities = [ordered]@{
    command = $command.Source
    mcp = $help -match '(?i)\bmcp\b'
    acp = $help -match '(?i)\bacp\b'
    plugin = $help -match '(?i)\bplugin\b'
    skill = $help -match '(?i)\bskill\b'
}
$capabilities | ConvertTo-Json
if (-not ($capabilities.mcp -or $capabilities.acp -or $capabilities.plugin)) { exit 2 }
