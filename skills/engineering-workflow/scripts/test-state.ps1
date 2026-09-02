param(
    [string]$WorkflowRoot = (Split-Path $PSScriptRoot -Parent)
)

$ErrorActionPreference = 'Stop'
$checker = Join-Path $PSScriptRoot 'workflow-state.ps1'
$contract = Join-Path (Split-Path $PSScriptRoot -Parent) 'references\state-machine.json'
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("engineering-workflow-state-tests-" + [guid]::NewGuid().ToString('N'))
$failures = New-Object System.Collections.Generic.List[string]

function Write-State([string]$Name, [object]$State) {
    $path = Join-Path $tempRoot "$Name.json"
    (ConvertTo-Json -InputObject $State -Depth 6) | Set-Content -LiteralPath $path -Encoding UTF8
    return $path
}

function Invoke-State([string]$Name, [string]$StatePath, [string]$Event, [string]$PreviousStatePath = '', [string[]]$Evidence = @()) {
    $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $checker, '-StatePath', $StatePath, '-Event', $Event, '-ContractPath', $contract)
    if ($PreviousStatePath) { $args += @('-PreviousStatePath', $PreviousStatePath) }
    if ($Evidence.Count -gt 0) { $args += @('-Evidence', $Evidence) }
    $output = @(& powershell.exe @args 2>&1)
    return [pscustomobject]@{ Name = $Name; ExitCode = $LASTEXITCODE; Output = ($output -join "`n") }
}

function Assert-Case([string]$Name, $Result, [int]$ExitCode, [string]$Pattern) {
    if ($Result.ExitCode -ne $ExitCode -or $Result.Output -notmatch $Pattern) {
        $failures.Add("$Name expected exit $ExitCode /$Pattern/; got $($Result.ExitCode): $($Result.Output)")
    } else { Write-Output "PASS CASE: $Name" }
}

try {
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

    $route = Write-State 'route' @{ flow='main'; status='active'; current_phase='route'; next_phase='execute'; plan_target='plan-1'; terminal_condition='tests pass'; resume_point='none' }
    Assert-Case 'legal route advance' (Invoke-State 'legal route advance' $route 'advance') 0 'PASS: workflow state is valid'

    $wrongPolicy = Write-State 'wrong-policy' @{ flow='main'; status='active'; current_phase='route'; next_phase='execute'; plan_target='plan-1'; terminal_condition='tests pass'; resume_point='none'; mode='standard'; policy_id='wrong-policy'; policy_version='3.0.0'; policy_digest=('sha256:' + ('0' * 64)) }
    Assert-Case 'policy-pinned state rejects wrong policy' (Invoke-State 'policy-pinned state rejects wrong policy' $wrongPolicy 'advance') 1 'State policy_id'

    $execute = Write-State 'execute' @{ flow='main'; status='active'; current_phase='execute'; next_phase='review'; plan_target='plan-1'; terminal_condition='tests pass'; resume_point='test receipt pending' }
    Assert-Case 'legal execute transition' (Invoke-State 'legal execute transition' $execute 'advance' $route) 0 'PASS: workflow state is valid'

    $illegal = Write-State 'illegal' @{ flow='main'; status='active'; current_phase='close'; next_phase='none'; plan_target='plan-1'; terminal_condition='tests pass'; resume_point='none' }
    Assert-Case 'illegal close transition' (Invoke-State 'illegal close transition' $illegal 'advance' $execute) 1 'Illegal phase transition'

    $notReady = Write-State 'not-ready' @{ flow='main'; status='active'; current_phase='spec'; next_phase='clarify'; plan_target='plan-1'; terminal_condition='acceptance agreed'; resume_point='missing acceptance decision' }
    Assert-Case 'spec not ready' (Invoke-State 'spec not ready' $notReady 'spec-not-ready') 0 'PASS: workflow state is valid'

    $failed = Write-State 'failed' @{ flow='main'; status='failed'; current_phase='execute'; next_phase='none'; plan_target='plan-1'; terminal_condition='tests pass'; resume_point='receipt at error-42' }
    Assert-Case 'failed state' (Invoke-State 'failed state' $failed 'unrecoverable-failure') 0 'PASS: workflow state is valid'
    $resumed = Write-State 'resumed' @{ flow='main'; status='active'; current_phase='route'; next_phase='execute'; plan_target='plan-1'; terminal_condition='tests pass'; resume_point='resume from error-42' }
    Assert-Case 'failed state needs explicit resume event' (Invoke-State 'implicit resume' $resumed 'advance' $failed) 1 "requires event 'user-resumed'"
    Assert-Case 'explicit failed resume' (Invoke-State 'explicit resume' $resumed 'user-resumed' $failed) 0 'PASS: workflow state is valid'

    $complete = Write-State 'complete' @{ flow='main'; status='complete'; current_phase='close'; next_phase='none'; plan_target='plan-1'; terminal_condition='tests pass'; resume_point='closed'; route=@{ skipped_phases=@('setup','prototype','tickets','goal'); approved_spec=$false }; history=@(@{ new_phase='clarify' },@{ new_phase='spec' },@{ new_phase='execute' },@{ new_phase='review' }); terminal_observation=@{ evidence_id='E-1'; artifact='test-receipt.json'; artifact_digest=('sha256:' + ('0' * 64)); observed_at='2026-08-13T00:00:00Z'; result='passed' }; review_findings=@() }
    Assert-Case 'complete requires evidence' (Invoke-State 'complete without evidence' $complete 'terminal-verified') 1 'requires a structured evidence file'
    $evidencePath = Join-Path $tempRoot 'evidence.json'
    [IO.File]::WriteAllText($evidencePath, '[{"evidence_id":"E-1","acceptance_ids":["AC-1"],"type":"test","result":"passed","artifact":"test-receipt.json","artifact_digest":"sha256:0000000000000000000000000000000000000000000000000000000000000000","command_or_request_id":"test","observed_at":"2026-08-13T00:00:00Z","producer":"test","environment":"local","delivery_generation":1,"subject_digest":"sha256:2222222222222222222222222222222222222222222222222222222222222222"}]', (New-Object Text.UTF8Encoding($false)))
    $completeOutput = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $checker -StatePath $complete -Event terminal-verified -ContractPath $contract -EvidencePath $evidencePath 2>&1)
    $completeResult = [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = ($completeOutput -join "`n") }
    Assert-Case 'complete with evidence' $completeResult 0 'PASS: workflow state is valid'

    if ($failures.Count -gt 0) {
        foreach ($failure in $failures) { Write-Output "FAIL CASE: $failure" }
        Write-Output "FAIL: $($failures.Count) state test case(s) failed."
        exit 1
    }
    Write-Output 'PASS: all workflow state test cases passed.'
    exit 0
} finally {
    if (Test-Path -LiteralPath $tempRoot -PathType Container) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
