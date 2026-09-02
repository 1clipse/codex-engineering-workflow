param(
    [string]$WorkflowRoot = (Split-Path $PSScriptRoot -Parent)
)

$ErrorActionPreference = 'Stop'
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("engineering-workflow-upgrade-tests-" + [guid]::NewGuid().ToString('N'))
$failures = New-Object System.Collections.Generic.List[string]

function Write-JsonFile([string]$Name, $Value) {
    $path = Join-Path $tempRoot $Name
    $parent = Split-Path $path -Parent
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) { [void][IO.Directory]::CreateDirectory($parent) }
    [IO.File]::WriteAllText($path, ($Value | ConvertTo-Json -Depth 10) + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
    return $path
}

function Invoke-Tool([string]$Script, [object[]]$Arguments) {
    $output = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot $Script) @Arguments 2>&1)
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = ($output -join "`n") }
}

function Assert-Case([string]$Name, $Result, [int]$ExitCode, [string]$Pattern) {
    if ($Result.ExitCode -ne $ExitCode -or $Result.Output -notmatch $Pattern) {
        $failures.Add("$Name expected exit $ExitCode /$Pattern/; got $($Result.ExitCode): $($Result.Output)")
    } else { Write-Output "PASS CASE: $Name" }
}

try {
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    $state = Write-JsonFile 'state.json' @{ flow='main'; status='active'; current_phase='execute'; next_phase='review'; plan_target='P001'; terminal_condition='tests and review pass'; resume_point='test receipt pending' }

    $native = Invoke-Tool 'native-plan.ps1' @('-StatePath', $state)
    Assert-Case 'native Plan mapping' $native 0 'current-session-only'
    Assert-Case 'native Plan is advisory' $native 0 'advisory-runtime-projection'
    Assert-Case 'native Plan is not a close gate' $native 0 '"required_for_close":\s*false'
    Assert-Case 'native Plan includes execute' $native 0 'Implement the approved contract'
    Assert-Case 'native Plan includes remaining close gate' $native 0 'Verify the terminal condition'

    $route = Write-JsonFile 'route.json' @{ run_id='run-1'; flow='main'; chosen_procedure='implement'; why='Small approved change'; phase_sequence=@('route','clarify','spec','execute','review','close'); confidence='high' }
    Assert-Case 'route record' (Invoke-Tool 'route-record.ps1' @('-RecordPath', $route)) 0 'chosen_procedure'
    $lowRoute = Write-JsonFile 'route-low.json' @{ run_id='run-2'; flow='main'; chosen_procedure='undecided'; why='Two routes remain plausible'; phase_sequence=@('route','clarify','spec','execute','review','close'); confidence='low' }
    Assert-Case 'low confidence route pauses' (Invoke-Tool 'route-record.ps1' @('-RecordPath', $lowRoute)) 0 'request the smallest user route choice'

    $evidence = Write-JsonFile 'evidence.json' @(
        @{ evidence_id='E-1'; acceptance_ids=@('AC-1'); type='test'; result='passed'; artifact='test-receipt.json'; artifact_digest=('sha256:' + ('0' * 64)); command_or_request_id='test'; observed_at='2026-08-13T00:00:00Z'; producer='test'; environment='local'; delivery_generation=1; subject_digest=('sha256:' + ('2' * 64)) },
        @{ evidence_id='E-2'; acceptance_ids=@('AC-2'); type='review'; result='verified'; artifact='review-receipt.json'; artifact_digest=('sha256:' + ('1' * 64)); command_or_request_id='review'; observed_at='2026-08-13T00:01:00Z'; producer='reviewer'; environment='local'; delivery_generation=1; subject_digest=('sha256:' + ('2' * 64)) }
    )
    Assert-Case 'structured evidence' (Invoke-Tool 'validate-evidence.ps1' @('-EvidencePath', $evidence)) 0 '2 structured evidence record'
    $badEvidence = Write-JsonFile 'bad-evidence.json' @(@{ evidence_id='E-bad'; acceptance_ids=@('AC-1'); type='test'; result='failed'; artifact='test-receipt.json'; artifact_digest=('sha256:' + ('0' * 64)); command_or_request_id='test'; observed_at='2026-08-13T00:00:00Z'; producer='test'; environment='local'; delivery_generation=1; subject_digest=('sha256:' + ('2' * 64)) })
    Assert-Case 'failed evidence rejected' (Invoke-Tool 'validate-evidence.ps1' @('-EvidencePath', $badEvidence)) 1 'invalid result'

    $planRoot = Join-Path $tempRoot 'docs\plantree\plans\001-demo'
    [void][IO.Directory]::CreateDirectory($planRoot)
    $target = Join-Path $planRoot 'implementation-status.md'
    [IO.File]::WriteAllText($target, "# Status`n", (New-Object Text.UTF8Encoding($false)))
    Assert-Case 'Plan Tree preview' (Invoke-Tool 'plan-tree-bridge.ps1' @('-PlanRoot', $planRoot, '-TargetFile', $target, '-StatePath', $state, '-RunId', 'run-1', '-Reason', 'test bridge', '-Evidence', 'test-receipt')) 0 'legacy bridge is read-only'
    if ((Get-Content -LiteralPath $target -Raw) -match 'engineering-workflow:state:start') { $failures.Add('Plan Tree preview modified the target.') }
    Assert-Case 'legacy Plan Tree apply disabled' (Invoke-Tool 'plan-tree-bridge.ps1' @('-PlanRoot', $planRoot, '-TargetFile', $target, '-StatePath', $state, '-RunId', 'run-1', '-Reason', 'test bridge', '-Evidence', 'test-receipt', '-Apply')) 1 'Legacy Plan Tree writes are disabled'
    if (@(Get-ChildItem -LiteralPath $planRoot -Filter 'implementation-status.md.*.bak' -File).Count -ne 0) { $failures.Add('Read-only Plan Tree bridge unexpectedly created a backup.') }
    $outside = Join-Path $tempRoot 'outside.md'
    [IO.File]::WriteAllText($outside, '# Outside')
    Assert-Case 'Plan Tree containment' (Invoke-Tool 'plan-tree-bridge.ps1' @('-PlanRoot', $planRoot, '-TargetFile', $outside, '-StatePath', $state, '-RunId', 'run-1', '-Reason', 'bad target')) 1 'must be inside PlanRoot'

    $log = Join-Path $tempRoot 'transitions.jsonl'
    $logLines = @(
        '{"timestamp_utc":"2026-08-13T00:00:00Z","run_id":"run-1","event":"route-selected","status":"active","current_phase":"route"}',
        '{"timestamp_utc":"2026-08-13T00:01:00Z","run_id":"run-1","event":"advance","status":"active","current_phase":"clarify"}',
        '{"timestamp_utc":"2026-08-13T00:03:00Z","run_id":"run-1","event":"advance","status":"partial","current_phase":"execute"}',
        '{"timestamp_utc":"2026-08-13T00:05:00Z","run_id":"run-1","event":"advance","status":"failed","current_phase":"execute"}'
    )
    [IO.File]::WriteAllLines($log, $logLines, (New-Object Text.UTF8Encoding($false)))
    $metrics = Invoke-Tool 'metrics.ps1' @('-LogPath', $log)
    Assert-Case 'aggregate metrics' $metrics 0 '"route_count"\s*:\s*1'
    Assert-Case 'aggregate phase duration' $metrics 0 'time_in_each_phase_seconds'

    if ($failures.Count -gt 0) {
        foreach ($failure in $failures) { Write-Output "FAIL CASE: $failure" }
        Write-Output "FAIL: $($failures.Count) upgrade test case(s) failed."
        exit 1
    }
    Write-Output 'PASS: all workflow upgrade test cases passed.'
    exit 0
} finally {
    if (Test-Path -LiteralPath $tempRoot -PathType Container) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}
