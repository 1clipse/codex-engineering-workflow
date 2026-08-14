param(
    [Parameter(Mandatory = $true)]
    [string]$PlanRoot,
    [Parameter(Mandatory = $true)]
    [string]$TargetFile,
    [Parameter(Mandatory = $true)]
    [string]$StatePath,
    [string]$RunId,
    [string]$Reason,
    [string[]]$Evidence = @(),
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$start = '<!-- engineering-workflow:state:start -->'
$end = '<!-- engineering-workflow:state:end -->'

function Resolve-Contained([string]$Root, [string]$Path, [string]$Label) {
    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    $pathFull = [IO.Path]::GetFullPath($Path)
    if (-not $pathFull.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) { throw "$Label must be inside PlanRoot: $Path" }
    return $pathFull
}

try {
    $planRootFull = [IO.Path]::GetFullPath($PlanRoot)
    $targetFull = Resolve-Contained $planRootFull $TargetFile 'TargetFile'
    if (-not (Test-Path -LiteralPath $planRootFull -PathType Container)) { throw "PlanRoot is missing: $PlanRoot" }
    if (-not (Test-Path -LiteralPath $targetFull -PathType Leaf)) { throw "TargetFile is missing: $TargetFile" }
    if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) { throw "StatePath is missing: $StatePath" }
    $state = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
    foreach ($field in @('flow', 'status', 'current_phase', 'next_phase', 'plan_target', 'terminal_condition', 'resume_point')) {
        if (-not $state.PSObject.Properties[$field] -or [string]::IsNullOrWhiteSpace([string]$state.$field)) { throw "Workflow state is missing: $field" }
    }
    if ([string]::IsNullOrWhiteSpace($RunId)) { throw '-RunId is required.' }
    if ([string]::IsNullOrWhiteSpace($Reason)) { throw '-Reason is required.' }
    $existing = Get-Content -LiteralPath $targetFull -Raw
    $block = @(
        $start,
        "flow: $($state.flow)",
        "status: $($state.status)",
        "current_phase: $($state.current_phase)",
        "next_phase: $($state.next_phase)",
        "plan_target: $($state.plan_target)",
        "terminal_condition: $($state.terminal_condition)",
        "resume_point: $($state.resume_point)",
        "run_id: $RunId",
        "reason: $Reason",
        "evidence: $($Evidence -join ', ')",
        $end
    ) -join "`n"
    $startCount = ([regex]::Matches($existing, [regex]::Escape($start))).Count
    $endCount = ([regex]::Matches($existing, [regex]::Escape($end))).Count
    if ($startCount -gt 1 -or $endCount -gt 1 -or $startCount -ne $endCount) { throw 'TargetFile has invalid engineering-workflow state markers.' }
    if ($startCount -eq 1) {
        $blockRegex = New-Object System.Text.RegularExpressions.Regex('(?s)<!-- engineering-workflow:state:start -->.*?<!-- engineering-workflow:state:end -->')
        $updated = $blockRegex.Replace($existing, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $block }, 1)
    } else {
        $updated = $existing.TrimEnd() + "`n`n" + $block + "`n"
    }
    if (-not $Apply) {
        Write-Output 'PREVIEW: legacy bridge is read-only; no Plan Tree file was changed.'
        Write-Output $block
        exit 0
    }
    throw 'Legacy Plan Tree writes are disabled. Use the delivery-control MCP commit_transition tool.'
} catch {
    Write-Output "FATAL: $($_.Exception.Message)"
    exit 1
}
