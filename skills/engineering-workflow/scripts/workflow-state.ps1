param(
    [Parameter(Mandatory = $true)]
    [string]$StatePath,
    [string]$PreviousStatePath,
    [string]$Event = 'advance',
    [string]$ContractPath,
    [string]$RunId,
    [string]$Reason,
    [string[]]$Evidence = @(),
    [string]$LogPath,
    [string]$EvidencePath,
    [string]$EvidenceSchemaPath
)

$ErrorActionPreference = 'Stop'
$errors = New-Object System.Collections.Generic.List[string]

function Read-Json([string]$Path, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Label is missing: $Path"
    }
    try { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json }
    catch { throw "$Label is invalid JSON: $($_.Exception.Message)" }
}

function Get-RuleValues($Object, [string]$Name) {
    $property = $Object.PSObject.Properties[$Name]
    if (-not $property) { return @() }
    return @($property.Value)
}

function Test-RequiredText($State, [string]$Name) {
    $property = $State.PSObject.Properties[$Name]
    if (-not $property -or $null -eq $property.Value -or [string]::IsNullOrWhiteSpace([string]$property.Value)) {
        $errors.Add("Required state field is missing or empty: $Name")
        return $false
    }
    return $true
}

try {
    if ([string]::IsNullOrWhiteSpace($ContractPath)) { $ContractPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'references\state-machine.json' }
    if ([string]::IsNullOrWhiteSpace($EvidenceSchemaPath)) { $EvidenceSchemaPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'references\evidence-schema.json' }
    $contract = Read-Json $ContractPath 'State-machine contract'
    $state = Read-Json $StatePath 'Workflow state'
    if ($EvidencePath) {
        $evidenceValidator = Join-Path $PSScriptRoot 'validate-evidence.ps1'
        if (-not (Test-Path -LiteralPath $evidenceValidator -PathType Leaf)) { $errors.Add("Structured evidence validator is missing: $evidenceValidator") }
        else {
            $evidenceOutput = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $evidenceValidator -EvidencePath $EvidencePath -SchemaPath $EvidenceSchemaPath 2>&1)
            if ($LASTEXITCODE -ne 0) { foreach ($line in $evidenceOutput) { $errors.Add([string]$line) } }
        }
    }
    $previous = $null
    if ($PreviousStatePath) { $previous = Read-Json $PreviousStatePath 'Previous workflow state' }

    foreach ($field in @($contract.required_fields)) { [void](Test-RequiredText $state ([string]$field)) }

    # This script remains a read-only compatibility checker. Policy-pinned states
    # are checked when present; older Plan Tree artifacts can still be inspected
    # and must be migrated through Delivery Control rather than rewritten here.
    $policyFields = @('mode', 'policy_id', 'policy_version', 'policy_digest')
    $presentPolicyFields = @($policyFields | Where-Object { $state.PSObject.Properties[$_] })
    if ($presentPolicyFields.Count -gt 0) {
        foreach ($field in $policyFields) { [void](Test-RequiredText $state $field) }
        if ([string]$state.policy_id -ne [string]$contract.policy_id) {
            $errors.Add("State policy_id '$($state.policy_id)' does not match canonical policy '$($contract.policy_id)'.")
        }
        if ([string]$state.policy_version -ne [string]$contract.schema_version) {
            $errors.Add("State policy_version '$($state.policy_version)' does not match canonical schema '$($contract.schema_version)'.")
        }
        if ([string]$state.policy_digest -notmatch '^sha256:[0-9a-f]{64}$') {
            $errors.Add('State policy_digest must be sha256:<64 lowercase hexadecimal characters>.')
        }
        if ($state.mode -notin @($contract.modes.profiles.PSObject.Properties.Name)) {
            $errors.Add("State mode is not defined by the canonical policy: $($state.mode)")
        }
    }

    if ($state.flow -notin @($contract.flows)) { $errors.Add("Unknown flow: $($state.flow)") }
    if ($state.status -notin @($contract.statuses)) { $errors.Add("Unknown status: $($state.status)") }
    if ($state.current_phase -notin @($contract.phases)) { $errors.Add("Unknown current_phase: $($state.current_phase)") }
    if ($state.next_phase -ne 'none' -and $state.next_phase -notin @($contract.phases)) {
        $errors.Add("Unknown next_phase: $($state.next_phase)")
    }

    $eventProperty = $contract.event_rules.PSObject.Properties[$Event]
    if (-not $eventProperty) {
        $errors.Add("Unknown workflow event: $Event")
    } else {
        $eventRule = $eventProperty.Value
        foreach ($field in @('flow', 'status', 'current_phase', 'next_phase')) {
            $allowed = Get-RuleValues $eventRule $field
            if ($allowed.Count -gt 0 -and $state.$field -notin $allowed) {
                $errors.Add("Event '$Event' requires $field in [$($allowed -join ', ')]; found '$($state.$field)'.")
            }
        }
    }

    if ($previous) {
        foreach ($field in @($contract.required_fields)) { [void](Test-RequiredText $previous ([string]$field)) }
        if ($previous.flow -ne $state.flow) {
            $errors.Add("Flow identity changed from '$($previous.flow)' to '$($state.flow)'; start a new flow instead.")
        }

        $phaseProperty = $contract.allowed_phase_transitions.PSObject.Properties[[string]$previous.current_phase]
        if (-not $phaseProperty -or $state.current_phase -notin @($phaseProperty.Value)) {
            $errors.Add("Illegal phase transition: $($previous.current_phase) -> $($state.current_phase)")
        }

        $statusProperty = $contract.allowed_status_transitions.PSObject.Properties[[string]$previous.status]
        if (-not $statusProperty -or $state.status -notin @($statusProperty.Value)) {
            $errors.Add("Illegal status transition: $($previous.status) -> $($state.status)")
        }
        if ($previous.status -in @('failed', 'cancelled') -and $state.status -eq 'active' -and $Event -ne 'user-resumed') {
            $errors.Add("Resuming status '$($previous.status)' requires event 'user-resumed'.")
        }
        $previousFindingIds = @($previous.review_findings | ForEach-Object { [string]$_.finding_id })
        $currentFindingIds = @($state.review_findings | ForEach-Object { [string]$_.finding_id })
        foreach ($findingId in $previousFindingIds) {
            if ($findingId -notin $currentFindingIds) { $errors.Add("Review finding '$findingId' cannot be silently removed.") }
        }
    }

    if ($state.status -eq 'complete') {
        if ($state.current_phase -ne 'close' -or $state.next_phase -ne 'none') {
            $errors.Add('Complete state requires current_phase=close and next_phase=none.')
        }
        if ($Event -ne 'terminal-verified') {
            $errors.Add("Complete state requires event 'terminal-verified'.")
        }
        if (-not $EvidencePath) {
            $errors.Add('Complete state requires a structured evidence file via -EvidencePath.')
        }
        if (-not $state.terminal_observation) {
            $errors.Add('Complete state requires terminal_observation evidence.')
        }
    } elseif ($state.current_phase -eq 'close') {
        $errors.Add('current_phase=close is reserved for status=complete.')
    }

    if ($state.status -in @('failed', 'cancelled') -and $state.next_phase -ne 'none') {
        $errors.Add("Status '$($state.status)' requires next_phase=none.")
    }
    if ($state.status -in @('awaiting-user', 'blocked-external', 'partial', 'failed', 'cancelled') -and
        [string]::IsNullOrWhiteSpace([string]$state.resume_point)) {
        $errors.Add("Status '$($state.status)' requires a non-empty resume_point.")
    }

    foreach ($finding in @($state.review_findings)) {
        if ([string]$finding.disposition -eq 'open') { $errors.Add("Review finding '$($finding.finding_id)' is still open.") }
        if ([string]$finding.severity -in @('P0', 'P1') -and ([string]$finding.disposition -ne 'fixed' -or [string]::IsNullOrWhiteSpace([string]$finding.reverified_by))) {
            $errors.Add("P0/P1 review finding '$($finding.finding_id)' must be fixed and include reverified_by.")
        }
    }

    if ($state.status -eq 'complete') {
        $requiredProperty = $contract.required_phases_by_flow.PSObject.Properties[[string]$state.flow]
        $required = if ($requiredProperty) { @($requiredProperty.Value) } else { @() }
        $completed = New-Object System.Collections.Generic.HashSet[string]
        [void]$completed.Add([string]$state.current_phase)
        foreach ($historyItem in @($state.history)) { if ($historyItem.new_phase) { [void]$completed.Add([string]$historyItem.new_phase) } }
        $skipped = @()
        if ($state.route -and $state.route.skipped_phases) { $skipped = @($state.route.skipped_phases) }
        foreach ($phase in $required) {
            $approvedSpec = ([string]$phase -eq 'spec' -and $state.route -and $state.route.approved_spec -eq $true)
            if ($phase -in $skipped -and -not $approvedSpec) { $errors.Add("Required phase cannot be skipped: $phase") }
            if (-not $completed.Contains([string]$phase) -and -not $approvedSpec) { $errors.Add("Required phase is incomplete: $phase") }
        }
    }

    if ($state.terminal_observation -and $EvidencePath -and (Test-Path -LiteralPath $EvidencePath -PathType Leaf)) {
        try {
            $evidenceRecords = @(Get-Content -LiteralPath $EvidencePath -Raw | ConvertFrom-Json)
            $terminal = @($evidenceRecords | Where-Object { [string]$_.evidence_id -eq [string]$state.terminal_observation.evidence_id }) | Select-Object -First 1
            if (-not $terminal -or [string]$terminal.artifact_digest -ne [string]$state.terminal_observation.artifact_digest) {
                $errors.Add('terminal_observation must reference a current evidence record with the same artifact digest.')
            }
        } catch { $errors.Add("Unable to validate terminal_observation evidence: $($_.Exception.Message)") }
    }

    if ($errors.Count -gt 0) {
        foreach ($message in $errors) { Write-Output "FATAL: $message" }
        Write-Output "FAIL: $($errors.Count) workflow state issue(s)."
        exit 1
    }

    if ($LogPath) {
        if ([string]::IsNullOrWhiteSpace($RunId) -or [string]::IsNullOrWhiteSpace($Reason)) {
            Write-Output 'FATAL: -RunId and -Reason are required when -LogPath is used.'
            exit 1
        }
        $logSafetyText = @($Reason, [string]$state.resume_point) + @($Evidence)
        if (($logSafetyText -join ' ') -match '(?i)(sk-[A-Za-z0-9_-]{12,}|bearer\s+[A-Za-z0-9._-]{12,}|api[_-]?key\s*[:=])') {
            Write-Output 'FATAL: transition metadata appears to contain a credential or secret.'
            exit 1
        }
        $logDirectory = Split-Path $LogPath -Parent
        if ($logDirectory -and -not (Test-Path -LiteralPath $logDirectory -PathType Container)) {
            [void][System.IO.Directory]::CreateDirectory($logDirectory)
        }
        $record = [ordered]@{
            timestamp_utc = [DateTime]::UtcNow.ToString('o')
            run_id = $RunId
            event = $Event
            previous_status = if ($previous) { [string]$previous.status } else { $null }
            previous_phase = if ($previous) { [string]$previous.current_phase } else { $null }
            status = [string]$state.status
            current_phase = [string]$state.current_phase
            next_phase = [string]$state.next_phase
            plan_target = [string]$state.plan_target
            reason = $Reason
            evidence = @($Evidence)
            resume_point = [string]$state.resume_point
        }
        $line = ($record | ConvertTo-Json -Compress -Depth 6) + [Environment]::NewLine
        [System.IO.File]::AppendAllText($LogPath, $line, (New-Object System.Text.UTF8Encoding($false)))
    }

    Write-Output "PASS: workflow state is valid for event '$Event'."
    exit 0
} catch {
    Write-Output "FATAL: $($_.Exception.Message)"
    Write-Output 'FAIL: workflow state validation could not run.'
    exit 1
}
