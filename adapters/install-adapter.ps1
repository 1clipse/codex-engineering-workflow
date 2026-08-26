param(
    [Parameter(Mandatory = $true)]
    [Alias('Host')]
    [ValidateSet('claude-code', 'opencode', 'dsh', 'pi', 'zcode')]
    [string]$AgentHost,
    [string]$ProjectRoot = (Split-Path $PSScriptRoot -Parent),
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'

function Expand-Template($Value, [hashtable]$Tokens) {
    if ($Value -is [string]) {
        $expanded = $Value
        foreach ($key in $Tokens.Keys) { $expanded = $expanded.Replace("{$key}", $Tokens[$key]) }
        return $expanded
    }
    if ($Value -is [System.Collections.IDictionary]) {
        $result = [ordered]@{}
        foreach ($key in $Value.Keys) { $result[$key] = Expand-Template $Value[$key] $Tokens }
        return $result
    }
    if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string]) {
        $items = @($Value | ForEach-Object { Expand-Template $_ $Tokens })
        return ,$items
    }
    if ($Value -and $Value.PSObject.Properties.Count -gt 0) {
        $result = [ordered]@{}
        foreach ($property in $Value.PSObject.Properties) { $result[$property.Name] = Expand-Template $property.Value $Tokens }
        return $result
    }
    return $Value
}

$resolvedRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$definitionPath = Join-Path $resolvedRoot 'plugins\delivery-control\schemas\workflow-policy.json'
if (-not (Test-Path -LiteralPath $definitionPath -PathType Leaf)) { throw "Canonical workflow definition is missing: $definitionPath" }
$definition = Get-Content -LiteralPath $definitionPath -Raw | ConvertFrom-Json
$profile = $definition.host_profiles.PSObject.Properties[$AgentHost].Value
if (-not $profile) { throw "Host profile is missing: $AgentHost" }
$serverPath = Join-Path $resolvedRoot 'plugins\delivery-control\dist\server.mjs'
if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) { throw "Build Delivery Control first: $serverPath" }

if ($profile.adapter.format -eq 'probe') {
    & (Join-Path $PSScriptRoot 'zcode\probe-zcode.ps1')
    exit $LASTEXITCODE
}
if ($profile.adapter.format -eq 'extension') {
    Write-Output "Pi bridge source: $(Join-Path $resolvedRoot 'adapters\pi\index.ts')"
    Write-Output 'Install it into .pi/extensions/delivery-control/ after running npm install in adapters/pi.'
    exit 0
}

$tokens = @{ PROJECT_ROOT = $resolvedRoot; SERVER_PATH = $serverPath }
$content = Expand-Template $profile.adapter.template $tokens
if (-not $OutputPath) {
    $extension = if ($profile.adapter.format -eq 'json') { 'json' } else { 'yml' }
    $OutputPath = Join-Path $resolvedRoot ("adapters\generated\$AgentHost.$extension")
}
$parent = Split-Path $OutputPath -Parent
if ($parent -and -not (Test-Path -LiteralPath $parent)) { [void][IO.Directory]::CreateDirectory($parent) }
if ($profile.adapter.format -eq 'json') {
    [IO.File]::WriteAllText($OutputPath, (($content | ConvertTo-Json -Depth 20) + [Environment]::NewLine), (New-Object Text.UTF8Encoding($false)))
} else {
    [IO.File]::WriteAllText($OutputPath, ([string]$content), (New-Object Text.UTF8Encoding($false)))
}
Write-Output "Generated $AgentHost adapter: $OutputPath"
