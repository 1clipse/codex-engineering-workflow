param(
    [string]$WorkflowRoot = (Split-Path $PSScriptRoot -Parent),
    [string]$DeliveryPluginRoot = (Join-Path (Split-Path (Split-Path (Split-Path $WorkflowRoot -Parent) -Parent) -Parent) 'plugins\delivery-control')
)

$ErrorActionPreference = 'Stop'
$source = Join-Path $WorkflowRoot 'references\state-machine.json'
$target = Join-Path $DeliveryPluginRoot 'schemas\workflow-policy.json'
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Canonical workflow policy is missing: $source" }
if (-not (Test-Path -LiteralPath (Split-Path $target -Parent) -PathType Container)) { New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null }
Copy-Item -LiteralPath $source -Destination $target -Force
Write-Output "Synchronized workflow policy: $target"
