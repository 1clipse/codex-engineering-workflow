param(
    [string]$SkillsRoot = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent),
    [string]$WorkflowRoot = (Split-Path $PSScriptRoot -Parent),
    [string]$AgentsFile,
    [string]$ProductDesignRoot,
    [string]$DeliveryPluginRoot
)

$ErrorActionPreference = 'Stop'
$fatal = New-Object System.Collections.Generic.List[string]
$warning = New-Object System.Collections.Generic.List[string]
$checkedSkills = New-Object System.Collections.Generic.List[string]

function Add-Fatal([string]$Message) { $fatal.Add($Message) }
function Add-Warning([string]$Message) { $warning.Add($Message) }

function Read-Text([string]$Path, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Add-Fatal "$Label is missing: $Path"
        return $null
    }
    try { return Get-Content -LiteralPath $Path -Raw }
    catch {
        Add-Fatal "Unable to read $Label at ${Path}: $($_.Exception.Message)"
        return $null
    }
}

function Get-Frontmatter([string]$Content, [string]$Label) {
    if (-not $Content) { return $null }
    $normalized = $Content -replace "`r`n", "`n"
    $match = [regex]::Match($normalized, '(?s)\A---\n(?<body>.*?)\n---(?:\n|\z)')
    if (-not $match.Success) {
        Add-Fatal "$Label frontmatter delimiters are invalid."
        return $null
    }
    return $match.Groups['body'].Value
}

function Get-SimpleYamlValue([string]$Content, [string]$Key) {
    $match = [regex]::Match($Content, "(?m)^\s*$([regex]::Escape($Key)):\s*(?<value>.+?)\s*$")
    if (-not $match.Success) { return $null }
    $value = $match.Groups['value'].Value.Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
        ($value.StartsWith("'") -and $value.EndsWith("'"))) {
        return $value.Substring(1, $value.Length - 2)
    }
    return $value
}

function Read-Json([string]$Path, [string]$Label) {
    $content = Read-Text $Path $Label
    if (-not $content) { return $null }
    try { return $content | ConvertFrom-Json }
    catch {
        Add-Fatal "$Label is invalid JSON: $($_.Exception.Message)"
        return $null
    }
}

function Test-RelativeMarkdownLinks([string]$File) {
    $content = Read-Text $File "Markdown source"
    if (-not $content) { return }
    $directory = Split-Path $File -Parent
    $matches = [regex]::Matches($content, '(?m)(?!!)\[[^\]]*\]\((?<target>[^)]+)\)')
    foreach ($match in $matches) {
        $target = $match.Groups['target'].Value.Trim().Trim('<', '>')
        if (-not $target -or $target.StartsWith('#') -or
            $target -match '^[a-z][a-z0-9+.-]*:' -or $target.StartsWith('/') -or
            $target -match '[*{}<>]' -or $target -match '^www\.') { continue }

        $target = ($target -split '#', 2)[0]
        $target = ($target -split '\?', 2)[0]
        if (-not $target) { continue }
        if ($target -notmatch '[\\/]' -and $target -notmatch '\.[A-Za-z0-9]{1,8}$') { continue }
        try { $target = [uri]::UnescapeDataString($target) } catch { }
        $resolved = [System.IO.Path]::GetFullPath((Join-Path $directory $target))
        if (-not (Test-Path -LiteralPath $resolved)) {
            Add-Fatal "Broken relative Markdown link in ${File}: $target"
        }
    }
}

$workflowFile = Join-Path $WorkflowRoot 'SKILL.md'
$uiFile = Join-Path $WorkflowRoot 'agents\openai.yaml'
$askMattFile = Join-Path $SkillsRoot 'ask-matt\SKILL.md'
$phaseBoundariesFile = Join-Path $SkillsRoot 'ask-matt\PHASE-BOUNDARIES.md'
$planTreeVersionFile = Join-Path $SkillsRoot 'plan-tree\VERSION'
$stateMachineFile = Join-Path $WorkflowRoot 'references\state-machine.json'
$compatibilityFile = Join-Path $WorkflowRoot 'references\compatibility.json'
$routeCasesFile = Join-Path $WorkflowRoot 'references\route-cases.json'
$nativePlanFile = Join-Path $WorkflowRoot 'references\native-plan.json'
$routeRecordFile = Join-Path $WorkflowRoot 'references\route-record.json'
$evidenceSchemaFile = Join-Path $WorkflowRoot 'references\evidence-schema.json'
$stateToolFile = Join-Path $WorkflowRoot 'scripts\workflow-state.ps1'
$stateTestFile = Join-Path $WorkflowRoot 'scripts\test-state.ps1'
$nativePlanToolFile = Join-Path $WorkflowRoot 'scripts\native-plan.ps1'
$bridgeToolFile = Join-Path $WorkflowRoot 'scripts\plan-tree-bridge.ps1'
$evidenceToolFile = Join-Path $WorkflowRoot 'scripts\validate-evidence.ps1'
$routeRecordToolFile = Join-Path $WorkflowRoot 'scripts\route-record.ps1'
$metricsToolFile = Join-Path $WorkflowRoot 'scripts\metrics.ps1'
$upgradeTestFile = Join-Path $WorkflowRoot 'scripts\test-upgrades.ps1'
if (-not $DeliveryPluginRoot) {
    $profileRoot = Split-Path (Split-Path $SkillsRoot -Parent) -Parent
    $DeliveryPluginRoot = Join-Path $profileRoot 'plugins\delivery-control'
}
$deliveryManifestFile = Join-Path $DeliveryPluginRoot '.codex-plugin\plugin.json'
$deliveryMcpFile = Join-Path $DeliveryPluginRoot '.mcp.json'
$deliverySkillFile = Join-Path $DeliveryPluginRoot 'skills\delivery-control\SKILL.md'
$deliveryServerFile = Join-Path $DeliveryPluginRoot 'dist\server.mjs'
if (-not $AgentsFile) { $AgentsFile = Join-Path (Split-Path $SkillsRoot -Parent) 'AGENTS.md' }
if (-not $ProductDesignRoot) {
    $pluginRoot = Join-Path (Split-Path $SkillsRoot -Parent) 'plugins\cache\openai-curated-remote\product-design'
    $candidate = Get-ChildItem -LiteralPath $pluginRoot -Directory -ErrorAction SilentlyContinue |
        Sort-Object { try { [version]$_.Name } catch { [version]'0.0' } } -Descending |
        Select-Object -First 1
    if ($candidate) { $ProductDesignRoot = $candidate.FullName }
}

$workflow = Read-Text $workflowFile 'engineering-workflow SKILL.md'
$stateMachine = Read-Json $stateMachineFile 'workflow state-machine contract'
$compatibility = Read-Json $compatibilityFile 'workflow compatibility contract'
$routeCases = Read-Json $routeCasesFile 'workflow route cases'
$nativePlan = Read-Json $nativePlanFile 'native Plan contract'
$routeRecord = Read-Json $routeRecordFile 'route-record contract'
$evidenceSchema = Read-Json $evidenceSchemaFile 'evidence schema'
$frontmatter = Get-Frontmatter $workflow 'engineering-workflow SKILL.md'
if ($frontmatter) {
    $name = Get-SimpleYamlValue $frontmatter 'name'
    $description = Get-SimpleYamlValue $frontmatter 'description'
    $frontmatterKeys = [regex]::Matches($frontmatter, '(?m)^(?<key>[A-Za-z0-9_-]+):') |
        ForEach-Object { $_.Groups['key'].Value }

    if ($name -ne 'engineering-workflow') { Add-Fatal "Unexpected skill name: $name" }
    if (-not $description -or $description.Length -gt 1024 -or $description -match '[<>]') {
        Add-Fatal 'Skill description is missing, too long, or contains forbidden angle brackets.'
    }
    if ($description -and ($description -notmatch '(?i)use plan-tree directly' -or
                           $description -notmatch '(?i)planning-only')) {
        Add-Fatal 'Skill description must route planning-only maintenance directly to plan-tree.'
    }
    $unexpectedKeys = @($frontmatterKeys | Where-Object { $_ -notin @('name', 'description') })
    if ($unexpectedKeys.Count -gt 0) {
        Add-Fatal "Unexpected SKILL.md frontmatter keys: $($unexpectedKeys -join ', ')"
    }
}

if ($workflow) {
    $contractFields = @('flow_id', 'revision', 'flow', 'status', 'current_phase', 'next_phase', 'plan_target', 'terminal_condition', 'resume_point')
    foreach ($field in $contractFields) {
        if ($workflow.IndexOf($field, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
            Add-Fatal "Flow contract field is missing: $field"
        }
    }

    $transitionSignals = @('SPEC NOT READY', 'Several frontier tickets', 'blocked-external', 'partial', 'failed fork', 'P0/P1', 'scope or architecture change', 'User cancellation', 'complete/close/none')
    foreach ($signal in $transitionSignals) {
        if ($workflow.IndexOf($signal, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
            Add-Fatal "Required lifecycle transition is missing: $signal"
        }
    }

    $authoritySignals = @('commit', 'push', 'PR', 'merge', 'deploy', 'tracker mutation', 'production-data', 'credential access', 'external messages', 'costly service calls')
    foreach ($signal in $authoritySignals) {
        if ($workflow.IndexOf($signal, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
            Add-Fatal "Required permission boundary is missing: $signal"
        }
    }
    $stateAuthoritySignals = @('CONTEXT.md', 'docs/adr/', 'tracker or `.scratch/`', 'Plan Tree owns', 'SQLite owns only')
    foreach ($signal in $stateAuthoritySignals) {
        if ($workflow.IndexOf($signal, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
            Add-Fatal "Required state-authority boundary is missing: $signal"
        }
    }

    $setupSignals = @('preserve the current state', 'enter `setup`', 're-read it', 'resume')
    foreach ($signal in $setupSignals) {
        if ($workflow.IndexOf($signal, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
            Add-Fatal "Required resumable setup step is missing: $signal"
        }
    }

    foreach ($signal in @('delivery-control', 'expected_revision', 'request_digest', 'select_route', 'commit_transition', 'recover_flow', 'project_native_plan', 'confirm_native_plan', 'validate_evidence', 'request_authorization', 'consume_authorization', 'close_flow', 'unmet_criteria')) {
        if ($workflow.IndexOf($signal, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
            Add-Fatal "Workflow upgrade contract is missing: $signal"
        }
    }
}

$deliveryManifest = Read-Json $deliveryManifestFile 'Delivery Control plugin manifest'
$deliveryMcp = Read-Json $deliveryMcpFile 'Delivery Control MCP configuration'
$deliverySkill = Read-Text $deliverySkillFile 'delivery-control SKILL.md'
$deliveryServer = Read-Text $deliveryServerFile 'Delivery Control bundled MCP server'
if ($deliveryManifest) {
    if ([string]$deliveryManifest.name -ne 'delivery-control') { Add-Fatal 'Delivery Control plugin manifest has the wrong name.' }
    try { $deliveryVersion = [version]([string]$deliveryManifest.version -replace '\+.*$','') } catch { Add-Fatal 'Delivery Control plugin version is invalid.'; $deliveryVersion = $null }
    if ($deliveryVersion -and $deliveryVersion -lt [version]'1.0.0') { Add-Fatal 'Delivery Control plugin 1.0.0 or newer is required.' }
    if ([string]$deliveryManifest.mcpServers -ne './.mcp.json' -or [string]$deliveryManifest.skills -ne './skills/') { Add-Fatal 'Delivery Control manifest must expose its MCP server and Skills.' }
}
if ($deliveryMcp) {
    $deliveryServerMapProperty = $deliveryMcp.PSObject.Properties['mcpServers']
    $deliveryServerMap = if ($deliveryServerMapProperty) { $deliveryServerMapProperty.Value } else { $null }
    $deliveryServerProperty = if ($deliveryServerMap) { $deliveryServerMap.PSObject.Properties['delivery-control'] } else { $null }
    if (-not $deliveryServerMapProperty -or -not $deliveryServerProperty) {
        Add-Fatal 'Delivery Control MCP server entry is missing.'
    } else {
        $deliveryServerEntry = $deliveryServerProperty.Value
        $deliveryServerArgs = @($deliveryServerEntry.args)
        if ([string]$deliveryServerEntry.command -ne 'node' -or [string]$deliveryServerEntry.cwd -ne '.' -or $deliveryServerArgs -notcontains './dist/server.mjs') {
            Add-Fatal 'Delivery Control MCP server command must use cwd "." and the plugin-relative ./dist/server.mjs entrypoint.'
        }
    }
}
if ($deliverySkill -and $deliverySkill -notmatch '(?m)^name:\s*delivery-control\s*$') { Add-Fatal 'Delivery Control Skill identity is invalid.' }
if ($deliveryServer) {
    foreach ($tool in @($compatibility.delivery_control.required_tools)) {
        if ($deliveryServer.IndexOf($tool, [System.StringComparison]::Ordinal) -lt 0) { Add-Fatal "Delivery Control MCP tool is missing: $tool" }
    }
}
if ($bridgeToolFile -and (Read-Text $bridgeToolFile 'legacy Plan Tree bridge') -notmatch 'Legacy Plan Tree writes are disabled') { Add-Fatal 'Legacy Plan Tree bridge still exposes a write path.' }

if ($stateMachine) {
    if ([string]$stateMachine.schema_version -ne '1.0.0') { Add-Fatal 'Unexpected state-machine schema_version.' }
    $expectedFields = @('flow', 'status', 'current_phase', 'next_phase', 'plan_target', 'terminal_condition', 'resume_point')
    foreach ($field in $expectedFields) {
        if ($field -notin @($stateMachine.required_fields)) { Add-Fatal "State-machine required field is missing: $field" }
    }
    foreach ($flow in @('main', 'bug', 'triage', 'wayfinder', 'maintenance', 'direct')) {
        if ($flow -notin @($stateMachine.flows)) { Add-Fatal "State-machine flow is missing: $flow" }
    }
    foreach ($status in @('active', 'awaiting-user', 'blocked-external', 'partial', 'failed', 'complete', 'cancelled')) {
        if ($status -notin @($stateMachine.statuses)) { Add-Fatal "State-machine status is missing: $status" }
        if (-not $stateMachine.allowed_status_transitions.PSObject.Properties[$status]) {
            Add-Fatal "State-machine status transition set is missing: $status"
        }
    }
    foreach ($phase in @('route', 'setup', 'clarify', 'prototype', 'spec', 'tickets', 'goal', 'execute', 'review', 'close')) {
        if ($phase -notin @($stateMachine.phases)) { Add-Fatal "State-machine phase is missing: $phase" }
        if (-not $stateMachine.allowed_phase_transitions.PSObject.Properties[$phase]) {
            Add-Fatal "State-machine phase transition set is missing: $phase"
        }
    }
    foreach ($event in @('advance', 'route-selected', 'spec-not-ready', 'several-frontiers', 'user-decision-needed',
            'external-blocker', 'partial-result', 'execution-blocked', 'unrecoverable-failure',
            'review-p0-p1', 'scope-change', 'user-cancelled', 'user-resumed', 'terminal-verified')) {
        if (-not $stateMachine.event_rules.PSObject.Properties[$event]) {
            Add-Fatal "State-machine event rule is missing: $event"
        }
    }
}

if ($compatibility) {
    if ([string]$compatibility.schema_version -ne '1.0.0') { Add-Fatal 'Unexpected compatibility schema_version.' }
    if (-not $compatibility.plan_tree.minimum_version) { Add-Fatal 'Compatibility contract is missing Plan Tree minimum_version.' }
    if (-not $compatibility.ask_matt.router_file -or -not $compatibility.ask_matt.phase_boundaries_file) {
        Add-Fatal 'Compatibility contract is missing Ask Matt file boundaries.'
    }
    if ('handoff' -ne [string]$compatibility.ask_matt.fallback_operation) {
        Add-Fatal 'Compatibility contract must use handoff as the context-operation fallback.'
    }
    foreach ($operation in @('clear', 'compact')) {
        if ($operation -notin @($compatibility.ask_matt.optional_host_operations)) {
            Add-Fatal "Compatibility contract optional host operation is missing: $operation"
        }
    }
    if ([string]$compatibility.product_design.plugin_name -ne 'product-design' -or
        -not $compatibility.product_design.minimum_version) {
        Add-Fatal 'Compatibility contract has invalid Product Design identity or minimum_version.'
    }
}

if ($routeCases) {
    if ([string]$routeCases.schema_version -ne '1.0.0') { Add-Fatal 'Unexpected route-case schema_version.' }
    $caseNames = New-Object System.Collections.Generic.List[string]
    foreach ($case in @($routeCases.cases)) {
        if (-not $case.name -or -not $case.request -or -not $case.expected_flow -or
            @($case.expected_route).Count -eq 0 -or -not $case.pause -or -not $case.completion_gate) {
            Add-Fatal 'Every route case must define name, request, expected_flow, expected_route, pause, and completion_gate.'
            continue
        }
        if ($caseNames.Contains([string]$case.name)) { Add-Fatal "Duplicate route case: $($case.name)" }
        else { $caseNames.Add([string]$case.name) }
        if ($stateMachine -and $case.expected_flow -notin @($stateMachine.flows)) {
            Add-Fatal "Route case '$($case.name)' uses unknown flow: $($case.expected_flow)"
        }
        foreach ($phase in @($case.expected_route)) {
            if ($stateMachine -and $phase -notin @($stateMachine.phases)) {
                Add-Fatal "Route case '$($case.name)' uses unknown phase: $phase"
            }
        }
    }
    foreach ($requiredCase in @('clear-small-feature', 'hard-regression', 'underspecified-feature', 'parallel-delivery',
            'new-visual-direction', 'visual-audit-only', 'planning-maintenance', 'production-release')) {
        if ($requiredCase -notin @($caseNames)) { Add-Fatal "Required route regression case is missing: $requiredCase" }
    }
}

if ($nativePlan) {
    if ([string]$nativePlan.schema_version -ne '2.0.0') { Add-Fatal 'Unexpected native-plan schema_version.' }
    if ([string]$nativePlan.scope -notmatch 'current-session-only' -or @($nativePlan.handshake).Count -ne 3) {
        Add-Fatal 'Native Plan contract must define the projection/update_plan/confirmation handshake.'
    }
    foreach ($phase in @('route', 'setup', 'clarify', 'prototype', 'spec', 'tickets', 'goal', 'execute', 'review', 'close')) {
        if (-not $nativePlan.phase_mapping.PSObject.Properties[$phase]) { Add-Fatal "Native Plan mapping is missing phase: $phase" }
    }
}

if ($routeRecord) {
    if ([string]$routeRecord.schema_version -ne '1.0.0') { Add-Fatal 'Unexpected route-record schema_version.' }
    foreach ($field in @('run_id', 'flow', 'chosen_procedure', 'why', 'skipped_phases', 'confidence')) {
        if ($field -notin @($routeRecord.required_fields)) { Add-Fatal "Route-record required field is missing: $field" }
    }
    foreach ($confidence in @('low', 'medium', 'high')) {
        if ($confidence -notin @($routeRecord.confidence_values)) { Add-Fatal "Route-record confidence value is missing: $confidence" }
    }
}

if ($evidenceSchema) {
    if ([string]$evidenceSchema.schema_version -ne '2.0.0') { Add-Fatal 'Unexpected evidence schema_version.' }
    foreach ($field in @('evidence_id', 'acceptance_ids', 'type', 'result', 'artifact', 'artifact_digest', 'command_or_request_id', 'observed_at', 'producer', 'environment')) {
        if ($field -notin @($evidenceSchema.required_fields)) { Add-Fatal "Evidence required field is missing: $field" }
    }
}

if (-not (Test-Path -LiteralPath $stateToolFile -PathType Leaf)) {
    Add-Fatal "Workflow state checker is missing: $stateToolFile"
} else {
    $parseErrors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($stateToolFile, [ref]$null, [ref]$parseErrors)
    if (@($parseErrors).Count -gt 0) { Add-Fatal "Workflow state checker has PowerShell syntax errors: $($parseErrors -join '; ')" }
}
if (-not (Test-Path -LiteralPath $stateTestFile -PathType Leaf)) {
    Add-Fatal "Workflow state regression test is missing: $stateTestFile"
}
foreach ($toolFile in @($nativePlanToolFile, $bridgeToolFile, $evidenceToolFile, $routeRecordToolFile, $metricsToolFile, $upgradeTestFile)) {
    if (-not (Test-Path -LiteralPath $toolFile -PathType Leaf)) { Add-Fatal "Workflow upgrade tool is missing: $toolFile" }
    else {
        $toolParseErrors = $null
        [void][System.Management.Automation.Language.Parser]::ParseFile($toolFile, [ref]$null, [ref]$toolParseErrors)
        if (@($toolParseErrors).Count -gt 0) { Add-Fatal "Workflow upgrade tool has PowerShell syntax errors at ${toolFile}: $($toolParseErrors -join '; ')" }
    }
}

$ui = Read-Text $uiFile 'agents/openai.yaml'
if ($ui) {
    if ($ui -notmatch '(?m)^interface:\s*$') { Add-Fatal 'agents/openai.yaml must contain an interface mapping.' }
    foreach ($key in @('display_name', 'short_description', 'default_prompt')) {
        $value = Get-SimpleYamlValue $ui $key
        if (-not $value) { Add-Fatal "agents/openai.yaml is missing interface.$key" }
    }
    $defaultPrompt = Get-SimpleYamlValue $ui 'default_prompt'
    if ($defaultPrompt -and $defaultPrompt -notmatch '\$engineering-workflow') {
        Add-Fatal 'agents/openai.yaml default_prompt must mention $engineering-workflow.'
    }
}

$askMatt = Read-Text $askMattFile 'ask-matt SKILL.md'
if (-not (Test-Path -LiteralPath $phaseBoundariesFile -PathType Leaf)) {
    Add-Fatal "Ask Matt phase-boundary reference is missing: $phaseBoundariesFile"
}

$optionalCapabilities = @('clear', 'compact')
if ($askMatt) {
    $procedureMatches = [regex]::Matches($askMatt, '`/(?<name>[a-z][a-z0-9-]+)(?:\s[^`]*)?`')
    $procedureNames = @($procedureMatches | ForEach-Object { $_.Groups['name'].Value } | Sort-Object -Unique)
    foreach ($procedure in $procedureNames) {
        $skillFile = Join-Path (Join-Path $SkillsRoot $procedure) 'SKILL.md'
        if ($procedure -in $optionalCapabilities) {
            # These are host context operations, not filesystem Skills.
            continue
        }
        if (-not (Test-Path -LiteralPath $skillFile -PathType Leaf)) {
            Add-Fatal "Ask Matt referenced Skill is missing: $procedure"
        } else { $checkedSkills.Add($procedure) }
    }

    if ($workflow -notmatch '(?is)PHASE-BOUNDARIES.*handoff') { Add-Fatal 'Ask Matt phase-boundary handoff fallback is not documented.' }
}

if ($workflow -and $workflow -match '(?i)Product Design') {
    if (-not $ProductDesignRoot -or -not (Test-Path -LiteralPath $ProductDesignRoot -PathType Container)) {
        Add-Fatal 'Product Design integration is documented but the plugin is not installed.'
    } else {
        $designManifest = Join-Path $ProductDesignRoot '.codex-plugin\plugin.json'
        $manifest = Read-Json $designManifest 'Product Design plugin manifest'
        if ($manifest -and [string]$manifest.name -ne [string]$compatibility.product_design.plugin_name) {
            Add-Fatal 'Product Design plugin manifest has an unexpected name.'
        }
        if ($manifest -and $compatibility) {
            try { $productDesignVersion = [version][string]$manifest.version }
            catch { Add-Fatal "Product Design manifest version is invalid: $($manifest.version)"; $productDesignVersion = $null }
            try { $minimumProductDesignVersion = [version][string]$compatibility.product_design.minimum_version }
            catch { Add-Fatal 'Product Design minimum compatibility version is invalid.'; $minimumProductDesignVersion = $null }
            if ($productDesignVersion -and $minimumProductDesignVersion -and $productDesignVersion -lt $minimumProductDesignVersion) {
                Add-Fatal "Product Design $minimumProductDesignVersion or newer is required; found $productDesignVersion"
            }
        }
        $designIndexRelative = if ($compatibility) { [string]$compatibility.product_design.router_file } else { 'skills/index/SKILL.md' }
        $designIndex = Join-Path $ProductDesignRoot ($designIndexRelative -replace '/', '\')
        if (-not (Test-Path -LiteralPath $designIndex -PathType Leaf)) {
            Add-Fatal "Product Design router Skill is missing: $designIndex"
        }
        $requiredDesignSkills = if ($compatibility) { @($compatibility.product_design.required_skills) } else { @('user-context','get-context','audit','ideate','prototype','image-to-code','url-to-code','design-qa') }
        foreach ($designSkill in $requiredDesignSkills) {
            $designFile = Join-Path $ProductDesignRoot "skills\$designSkill\SKILL.md"
            if (-not (Test-Path -LiteralPath $designFile -PathType Leaf)) {
                Add-Fatal "Product Design focused Skill is missing: $designSkill"
            }
        }
        foreach ($signal in @('get-context', 'three directions', 'Audit-only', 'design-qa.md', 'final result: passed', 'image-to-code', 'url-to-code')) {
            if ($workflow.IndexOf($signal, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
                Add-Fatal "Product Design integration rule is missing: $signal"
            }
        }
    }
}

$versionText = Read-Text $planTreeVersionFile 'plan-tree VERSION'
if ($versionText) {
    $versionText = $versionText.Trim()
    try { $planTreeVersion = [version]$versionText }
    catch {
        Add-Fatal "Plan Tree VERSION is not valid semantic numeric version text: $versionText"
        $planTreeVersion = $null
    }
    try { $minimumPlanTreeVersion = if ($compatibility) { [version][string]$compatibility.plan_tree.minimum_version } else { [version]'0.4.0' } }
    catch { Add-Fatal 'Plan Tree minimum compatibility version is invalid.'; $minimumPlanTreeVersion = $null }
    if ($planTreeVersion -and $minimumPlanTreeVersion -and $planTreeVersion -lt $minimumPlanTreeVersion) {
        Add-Fatal "Plan Tree $minimumPlanTreeVersion or newer is required; found $versionText"
    }
}

$agents = Read-Text $AgentsFile 'global AGENTS.md'
if ($agents) {
    $startMarker = '<!-- plan-tree:instructions:start -->'
    $endMarker = '<!-- plan-tree:instructions:end -->'
    $startCount = [regex]::Matches($agents, [regex]::Escape($startMarker)).Count
    $endCount = [regex]::Matches($agents, [regex]::Escape($endMarker)).Count
    if ($startCount -ne 1 -or $endCount -ne 1) {
        Add-Fatal "Global AGENTS.md must contain exactly one Plan Tree marker pair; found $startCount start and $endCount end markers."
    } elseif ($agents.IndexOf($startMarker) -gt $agents.IndexOf($endMarker)) {
        Add-Fatal 'Global AGENTS.md Plan Tree markers are in the wrong order.'
    }
}

$linkSources = New-Object System.Collections.Generic.List[string]
foreach ($source in @($workflowFile, $askMattFile, $phaseBoundariesFile)) {
    if ((Test-Path -LiteralPath $source -PathType Leaf) -and -not $linkSources.Contains($source)) {
        $linkSources.Add($source)
    }
}
foreach ($skill in @($checkedSkills | Sort-Object -Unique)) {
    $source = Join-Path (Join-Path $SkillsRoot $skill) 'SKILL.md'
    if (-not $linkSources.Contains($source)) { $linkSources.Add($source) }
}
foreach ($source in $linkSources) { Test-RelativeMarkdownLinks $source }

$quickValidator = Join-Path $SkillsRoot '.system\skill-creator\scripts\quick_validate.py'
if (-not (Test-Path -LiteralPath $quickValidator -PathType Leaf)) {
    Add-Warning 'Optional skill-creator quick_validate.py is unavailable; PowerShell structural validation was used.'
} else {
    $pythonCandidates = @()
    $codexRoot = Split-Path $SkillsRoot -Parent
    $profileRoot = Split-Path $codexRoot -Parent
    $pythonCandidates += Join-Path $profileRoot '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
    $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
    if ($pythonCommand) { $pythonCandidates += $pythonCommand.Source }
    $pythonUsable = $false
    $pythonPath = $null
    foreach ($candidatePath in @($pythonCandidates | Select-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $candidatePath -PathType Leaf)) { continue }
        try {
            $probe = & $candidatePath -c 'import yaml' 2>&1
            if ($LASTEXITCODE -eq 0) {
                $pythonUsable = $true
                $pythonPath = $candidatePath
                break
            }
        } catch { $pythonUsable = $false }
    }
    if (-not $pythonUsable) {
        Add-Warning 'Optional skill-creator quick_validate.py cannot run because a Python environment with PyYAML is unavailable; this is not a workflow failure.'
    } else {
        $quickOutput = @(& $pythonPath $quickValidator $WorkflowRoot 2>&1)
        if ($LASTEXITCODE -ne 0) {
            Add-Fatal "skill-creator quick_validate.py failed: $($quickOutput -join ' ')"
        }
    }
}

foreach ($message in $warning) { Write-Output "WARNING: $message" }
foreach ($message in $fatal) { Write-Output "FATAL: $message" }

if ($fatal.Count -gt 0) {
    Write-Output "FAIL: $($fatal.Count) fatal issue(s), $($warning.Count) warning(s)."
    exit 1
}

Write-Output "PASS: engineering-workflow validated; $($checkedSkills.Count) Ask Matt Skills checked, $($warning.Count) warning(s)."
exit 0
