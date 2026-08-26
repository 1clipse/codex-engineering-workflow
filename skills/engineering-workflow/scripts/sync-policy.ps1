param(
    [string]$WorkflowRoot = (Split-Path $PSScriptRoot -Parent),
    [string]$DeliveryPluginRoot = (Join-Path (Split-Path (Split-Path $WorkflowRoot -Parent) -Parent) 'plugins\delivery-control')
)

$ErrorActionPreference = 'Stop'
$generator = Join-Path $DeliveryPluginRoot 'scripts\generate-policy.mjs'
if (-not (Test-Path -LiteralPath $generator -PathType Leaf)) { throw "Policy generator is missing: $generator" }
& node $generator
if ($LASTEXITCODE -ne 0) { throw "Policy generation failed with exit code $LASTEXITCODE" }
