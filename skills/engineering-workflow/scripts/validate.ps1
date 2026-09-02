param(
    [string]$SkillsRoot = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent),
    [string]$WorkflowRoot = (Split-Path $PSScriptRoot -Parent),
    [string]$AgentsFile,
    [string]$ProductDesignRoot,
    [string]$DeliveryPluginRoot,
    [string]$AdaptersRoot
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
$hostCapabilitiesFile = Join-Path $WorkflowRoot 'references\host-capabilities.json'
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
$policySyncFile = Join-Path $WorkflowRoot 'scripts\sync-policy.ps1'
if (-not $DeliveryPluginRoot) {
    $profileRoot = Split-Path (Split-Path $SkillsRoot -Parent) -Parent
    $DeliveryPluginRoot = Join-Path $profileRoot 'plugins\delivery-control'
}
if (-not $AdaptersRoot) {
    $repositoryRoot = Split-Path (Split-Path $WorkflowRoot -Parent) -Parent
    $AdaptersRoot = Join-Path $repositoryRoot 'adapters'
}
$deliveryManifestFile = Join-Path $DeliveryPluginRoot '.codex-plugin\plugin.json'
$deliveryMcpFile = Join-Path $DeliveryPluginRoot '.mcp.json'
$deliverySkillFile = Join-Path $DeliveryPluginRoot 'skills\delivery-control\SKILL.md'
$deliveryServerFile = Join-Path $DeliveryPluginRoot 'dist\server.mjs'
$deliveryPolicyFile = Join-Path $DeliveryPluginRoot 'schemas\workflow-policy.json'
$deliveryStateSchemaFile = Join-Path $DeliveryPluginRoot 'schemas\flow-state.schema.json'
$deliveryHooksRoot = Join-Path $DeliveryPluginRoot 'hooks'
$deliveryHookTemplateFile = Join-Path $deliveryHooksRoot 'hooks.json.template'
$deliveryHookScriptFile = Join-Path $deliveryHooksRoot 'lifecycle-advisory.mjs'
$deliveryHookReadmeFile = Join-Path $deliveryHooksRoot 'README.md'
if (-not $AgentsFile) { $AgentsFile = Join-Path (Split-Path $SkillsRoot -Parent) 'AGENTS.md' }
if (-not $ProductDesignRoot) {
    $codexRoot = Split-Path $SkillsRoot -Parent
    $pluginRoot = Join-Path $codexRoot 'plugins\cache\openai-curated-remote\product-design'
    $candidate = Get-ChildItem -LiteralPath $pluginRoot -Directory -ErrorAction SilentlyContinue |
        Sort-Object { try { [version]$_.Name } catch { [version]'0.0' } } -Descending |
        Select-Object -First 1
    if ($candidate) { $ProductDesignRoot = $candidate.FullName }
    if (-not $ProductDesignRoot) {
        foreach ($candidatePath in @(
            (Join-Path $codexRoot '.tmp\plugins\plugins\product-design'),
            (Join-Path $codexRoot '.tmp\plugins-remote\plugins\product-design')
        )) {
            if (Test-Path -LiteralPath (Join-Path $candidatePath '.codex-plugin\plugin.json') -PathType Leaf) {
                $ProductDesignRoot = $candidatePath
                break
            }
        }
    }
}

$workflow = Read-Text $workflowFile 'engineering-workflow SKILL.md'
$stateMachine = Read-Json $stateMachineFile 'workflow state-machine contract'
$deliveryPolicy = Read-Json $deliveryPolicyFile 'Delivery Control workflow policy'
$compatibility = Read-Json $compatibilityFile 'workflow compatibility contract'
$routeCases = Read-Json $routeCasesFile 'workflow route cases'
$nativePlan = Read-Json $nativePlanFile 'native Plan contract'
$hostCapabilities = Read-Json $hostCapabilitiesFile 'host capabilities contract'
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
    foreach ($signal in @('references/state-machine.json', 'workflow-policy.json', 'Plan Tree', 'delivery-control', 'start_or_resume_flow', 'route_flow', 'checkpoint_flow', 'record_evidence', 'authorize_external_action', 'audit_or_recover_flow', 'close_or_cancel_flow')) {
        if ($workflow.IndexOf($signal, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
            Add-Fatal "Workflow loader is missing: $signal"
        }
    }
    if ($workflow -notmatch '(?is)JSON policy.*?(machine-checked|authoritative|canonical)') { Add-Fatal 'Workflow loader must declare the JSON policy authoritative.' }
    if ($workflow -notmatch '(?is)Host plan.*?(optional|advisory)') { Add-Fatal 'Workflow loader must describe host-native plans as advisory.' }
}

$deliveryManifest = Read-Json $deliveryManifestFile 'Delivery Control plugin manifest'
$deliveryMcp = Read-Json $deliveryMcpFile 'Delivery Control MCP configuration'
$deliverySkill = Read-Text $deliverySkillFile 'delivery-control SKILL.md'
$deliveryServer = Read-Text $deliveryServerFile 'Delivery Control bundled MCP server'
$deliveryStateSchema = Read-Json $deliveryStateSchemaFile 'Delivery Control generated flow-state schema'
$deliveryHookTemplate = Read-Json $deliveryHookTemplateFile 'Delivery Control lifecycle hook template'
$deliveryHookScript = Read-Text $deliveryHookScriptFile 'Delivery Control lifecycle hook script'
$deliveryHookReadme = Read-Text $deliveryHookReadmeFile 'Delivery Control lifecycle hook documentation'
if ($deliveryManifest) {
    if ([string]$deliveryManifest.name -ne 'delivery-control') { Add-Fatal 'Delivery Control plugin manifest has the wrong name.' }
    try { $deliveryVersion = [version]([string]$deliveryManifest.version -replace '\+.*$','') } catch { Add-Fatal 'Delivery Control plugin version is invalid.'; $deliveryVersion = $null }
    if ($deliveryVersion -and $deliveryVersion -lt [version]'3.0.0') { Add-Fatal 'Delivery Control plugin 3.0.0 or newer is required.' }
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
if ($deliveryServer -and $compatibility) {
    $registeredTools = @([regex]::Matches($deliveryServer, '(?m)^\s*register\(\s*["''](?<name>[A-Za-z0-9_-]+)["'']') |
        ForEach-Object { $_.Groups['name'].Value } | Sort-Object -Unique)
    $expectedTools = @($compatibility.delivery_control.public_tools | Sort-Object -Unique)
    foreach ($tool in $expectedTools) {
        if ($tool -notin $registeredTools) { Add-Fatal "Delivery Control MCP tool is missing: $tool" }
    }
    foreach ($tool in $registeredTools) {
        if ($tool -notin $expectedTools) { Add-Fatal "Delivery Control MCP public interface has unexpected tool: $tool" }
    }
    foreach ($legacyTool in @($compatibility.delivery_control.legacy_tools)) {
        if ($legacyTool -in $registeredTools) { Add-Fatal "Delivery Control MCP public interface still exposes legacy tool: $legacyTool" }
    }
}
if (Test-Path -LiteralPath (Join-Path $deliveryHooksRoot 'hooks.json') -PathType Leaf) {
    Add-Fatal 'Delivery Control must not ship an active hooks/hooks.json; only the opt-in template is allowed.'
}
if ($deliveryHookTemplate -and $stateMachine) {
    $templateEvents = @($deliveryHookTemplate.hooks.PSObject.Properties.Name | Sort-Object)
    $policyEvents = @($stateMachine.delivery_protocol.lifecycle_hooks.events | Sort-Object)
    if (($templateEvents -join '|') -ne ($policyEvents -join '|')) {
        Add-Fatal 'Delivery Control lifecycle hook template events differ from the canonical policy.'
    }
    foreach ($event in $templateEvents) {
        $groups = @($deliveryHookTemplate.hooks.PSObject.Properties[$event].Value)
        if ($groups.Count -eq 0 -or @($groups[0].hooks).Count -eq 0) {
            Add-Fatal "Delivery Control lifecycle hook template is incomplete for event: $event"
            continue
        }
        $handler = $groups[0].hooks[0]
        if ([string]$handler.type -ne 'command' -or [string]$handler.command -notmatch 'lifecycle-advisory\.mjs' -or
            [string]$handler.command -notmatch '<ABSOLUTE-DELIVERY-CONTROL-PLUGIN-ROOT>') {
            Add-Fatal "Delivery Control lifecycle hook template has an unsafe or non-portable handler for event: $event"
        }
    }
}
if ($deliveryHookScript) {
    foreach ($forbidden in @('writeFile', 'appendFile', 'rmSync', 'fetch(', 'http://', 'https://', 'spawn(', 'exec(')) {
        if ($deliveryHookScript.IndexOf($forbidden, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
            Add-Fatal "Delivery Control lifecycle hook must remain a pure advisory transform; found forbidden capability: $forbidden"
        }
    }
    if ($deliveryHookScript -notmatch 'process\.stdout\.write' -or $deliveryHookScript -notmatch 'continue:\s*true') {
        Add-Fatal 'Delivery Control lifecycle hook must return a non-blocking standard-output response.'
    }
}
if ($deliveryHookReadme -and ($deliveryHookReadme -notmatch '(?i)opt-in' -or $deliveryHookReadme -notmatch '(?i)fallback without hooks')) {
    Add-Fatal 'Delivery Control lifecycle hook documentation must explain opt-in activation and the no-hook fallback.'
}
if ($stateMachine -and $deliveryPolicy) {
    $canonicalPolicy = (Get-Content -LiteralPath $stateMachineFile -Raw | ConvertFrom-Json | ConvertTo-Json -Depth 30 -Compress)
    $bundledPolicy = (Get-Content -LiteralPath $deliveryPolicyFile -Raw | ConvertFrom-Json | ConvertTo-Json -Depth 30 -Compress)
    if ($canonicalPolicy -ne $bundledPolicy) { Add-Fatal 'Generated workflow state-machine.json differs from the canonical Delivery Control policy; run sync-policy.ps1.' }
}
if ($deliveryStateSchema -and $stateMachine) {
    foreach ($field in @('mode', 'policy_id', 'policy_version', 'policy_digest')) {
        if ($field -notin @($deliveryStateSchema.required)) { Add-Fatal "Generated flow-state schema required field is missing: $field" }
    }
    if ([string]$deliveryStateSchema.properties.policy_id.const -ne [string]$stateMachine.policy_id -or
        [string]$deliveryStateSchema.properties.policy_version.const -ne [string]$stateMachine.schema_version -or
        [string]$deliveryStateSchema.properties.policy_digest.const -notmatch '^sha256:[0-9a-f]{64}$') {
        Add-Fatal 'Generated flow-state schema is not pinned to the canonical workflow policy.'
    }
    foreach ($mode in @($stateMachine.modes.profiles.PSObject.Properties.Name)) {
        if ($mode -notin @($deliveryStateSchema.properties.mode.enum)) { Add-Fatal "Generated flow-state schema mode is missing: $mode" }
    }
}
if ($stateMachine) {
    if (-not $stateMachine.delivery_protocol -or -not $stateMachine.host_profiles) {
        Add-Fatal 'Canonical workflow JSON must define delivery_protocol and host_profiles.'
    }
    foreach ($field in @('authority', 'external_actions', 'artifact_roots', 'evidence_required_fields', 'close_gates', 'host_plan', 'lifecycle_hooks')) {
        if (-not $stateMachine.delivery_protocol.PSObject.Properties[$field]) { Add-Fatal "Canonical delivery_protocol is missing: $field" }
    }
    if ([string]$stateMachine.policy_id -ne [string]$compatibility.policy.policy_id) { Add-Fatal 'Canonical workflow JSON policy_id differs from compatibility contract.' }
    if ([string]$stateMachine.schema_version -ne [string]$compatibility.policy.minimum_schema_version) { Add-Fatal 'Canonical workflow JSON schema_version differs from compatibility contract.' }
    if ([string]$stateMachine.delivery_protocol.host_plan.role -ne [string]$compatibility.host_plan.role -or
        [bool]$stateMachine.delivery_protocol.host_plan.required_for_close) {
        Add-Fatal 'Canonical workflow JSON must mark host plans advisory and not required for close.'
    }
    foreach ($mode in @($compatibility.policy.modes)) {
        if (-not $stateMachine.modes.profiles.PSObject.Properties[$mode]) { Add-Fatal "Canonical workflow JSON mode is missing: $mode" }
    }
    $policyHooks = $stateMachine.delivery_protocol.lifecycle_hooks
    if ([string]$policyHooks.role -ne 'opt-in-advisory' -or [bool]$policyHooks.writes_state -or
        @($policyHooks.events).Count -ne 3 -or -not [string]$policyHooks.fallback) {
        Add-Fatal 'Canonical lifecycle hook policy must be opt-in, non-writing, and define its fallback.'
    }
}
if ($hostCapabilities) {
    if ([string]$hostCapabilities.authority -ne 'plugins/delivery-control/schemas/workflow-policy.json') {
        Add-Fatal 'Host capabilities contract has the wrong canonical authority.'
    }
    foreach ($agentHost in @('codex', 'claude-code', 'opencode', 'pi', 'dsh', 'zcode')) {
        $profile = $hostCapabilities.hosts.PSObject.Properties[$agentHost]
        if (-not $profile -or -not $profile.Value.support -or -not $profile.Value.adapter) { Add-Fatal "Host capabilities profile is incomplete: $agentHost" }
    }
    if ([string]$hostCapabilities.policy_id -ne [string]$stateMachine.policy_id -or
        [string]$hostCapabilities.schema_version -ne [string]$stateMachine.schema_version -or
        [string]$hostCapabilities.policy_digest -notmatch '^sha256:[0-9a-f]{64}$') {
        Add-Fatal 'Host capabilities contract is not pinned to the generated workflow policy.'
    }
}
$adapterFiles = @(
    'README.md', 'install-adapter.ps1', 'host-capabilities.json',
    'claude-code\SKILL.md', 'claude-code\claude-code.json.template',
    'opencode\engineering-workflow.md', 'opencode\opencode.json.template',
    'pi\SKILL.md', 'pi\index.ts', 'pi\package.json',
    'dsh\AGENTS.md', 'dsh\dsh.yml.template',
    'zcode\AGENTS.md', 'zcode\probe-zcode.ps1'
)
foreach ($adapterFile in $adapterFiles) {
    $path = Join-Path $AdaptersRoot $adapterFile
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { Add-Fatal "Cross-Agent adapter asset is missing: $adapterFile" }
}
if ($hostCapabilities -and (Test-Path -LiteralPath (Join-Path $AdaptersRoot 'host-capabilities.json') -PathType Leaf)) {
    $adapterCapabilities = Read-Json (Join-Path $AdaptersRoot 'host-capabilities.json') 'generated adapter host capabilities'
    if ($adapterCapabilities) {
        $workflowHostJson = ($hostCapabilities | ConvertTo-Json -Depth 30 -Compress)
        $adapterHostJson = ($adapterCapabilities | ConvertTo-Json -Depth 30 -Compress)
        if ($workflowHostJson -ne $adapterHostJson) { Add-Fatal 'Generated adapter host capabilities differ from the workflow reference.' }
    }
}
if ($bridgeToolFile -and (Read-Text $bridgeToolFile 'legacy Plan Tree bridge') -notmatch 'Legacy Plan Tree writes are disabled') { Add-Fatal 'Legacy Plan Tree bridge still exposes a write path.' }

if ($stateMachine) {
    if ([string]$stateMachine.schema_version -ne '3.0.0') { Add-Fatal 'Unexpected state-machine schema_version.' }
    if ([string]::IsNullOrWhiteSpace([string]$stateMachine.policy_id)) { Add-Fatal 'State-machine policy_id is missing.' }
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
    if (-not $stateMachine.required_phase_skip_exceptions) {
        Add-Fatal 'State-machine required_phase_skip_exceptions is missing.'
    } elseif ([string]$stateMachine.required_phase_skip_exceptions.spec -ne 'approved_spec') {
        Add-Fatal 'State-machine spec skip exception must be approved_spec.'
    }
    foreach ($flow in @('main', 'bug', 'triage', 'wayfinder', 'maintenance', 'direct')) {
        $requiredProperty = $stateMachine.required_phases_by_flow.PSObject.Properties[$flow]
        if (-not $requiredProperty) { Add-Fatal "State-machine required phase set is missing: $flow" }
        $templateProperty = $stateMachine.route_templates.PSObject.Properties[$flow]
        if (-not $templateProperty -or @($templateProperty.Value)[0] -ne 'route' -or @($templateProperty.Value)[-1] -ne 'close') { Add-Fatal "State-machine route template is invalid: $flow" }
    }
    foreach ($event in @('advance', 'phase-completed', 'external-action-observed', 'route-selected', 'spec-not-ready', 'several-frontiers', 'user-decision-needed',
            'external-blocker', 'partial-result', 'execution-blocked', 'unrecoverable-failure',
            'review-p0-p1', 'review-recorded', 'scope-change', 'user-cancelled', 'user-resumed', 'terminal-verified')) {
        if (-not $stateMachine.event_rules.PSObject.Properties[$event]) {
            Add-Fatal "State-machine event rule is missing: $event"
        }
    }
    foreach ($phase in @($stateMachine.phases)) {
        if (-not $stateMachine.phase_labels.PSObject.Properties[$phase] -or [string]::IsNullOrWhiteSpace([string]$stateMachine.phase_labels.$phase)) {
            Add-Fatal "State-machine phase label is missing: $phase"
        }
    }
    foreach ($mode in @('standard', 'strict')) {
        $profile = $stateMachine.modes.profiles.PSObject.Properties[$mode]
        if (-not $profile -or $null -eq $profile.Value.require_lease -or $null -eq $profile.Value.require_fixed_points) {
            Add-Fatal "State-machine mode profile is incomplete: $mode"
        }
    }
    foreach ($result in @('passed', 'verified', 'accepted', 'observed')) {
        if ($result -notin @($stateMachine.evidence_results)) { Add-Fatal "State-machine evidence result is missing: $result" }
    }
    foreach ($severity in @('P0', 'P1', 'P2', 'P3')) {
        if ($severity -notin @($stateMachine.review.severities)) { Add-Fatal "State-machine review severity is missing: $severity" }
    }
}

if ($compatibility) {
    if ([string]$compatibility.schema_version -ne '3.0.0') { Add-Fatal 'Unexpected compatibility schema_version.' }
    if ([string]$compatibility.policy.policy_id -ne 'com.1clipse.policy-driven-delivery-protocol' -or
        [string]$compatibility.policy.minimum_schema_version -ne '3.0.0' -or
        [string]$compatibility.policy.authority -ne 'plugins/delivery-control/schemas/workflow-policy.json') {
        Add-Fatal 'Compatibility contract has an invalid canonical policy identity.'
    }
    $publicTools = @($compatibility.delivery_control.public_tools)
    if ($publicTools.Count -ne 7 -or @($publicTools | Sort-Object -Unique).Count -ne 7) {
        Add-Fatal 'Compatibility contract must define exactly seven unique public Delivery Control tools.'
    }
    foreach ($tool in @('start_or_resume_flow', 'route_flow', 'checkpoint_flow', 'record_evidence', 'authorize_external_action', 'audit_or_recover_flow', 'close_or_cancel_flow')) {
        if ($tool -notin $publicTools) { Add-Fatal "Compatibility contract public tool is missing: $tool" }
    }
    if (@($publicTools | Where-Object { $_ -in @($compatibility.delivery_control.legacy_tools) }).Count -gt 0) {
        Add-Fatal 'Compatibility contract overlaps public and legacy Delivery Control tools.'
    }
    if ([string]$compatibility.host_plan.role -ne 'advisory-runtime-projection' -or [bool]$compatibility.host_plan.required_for_close) {
        Add-Fatal 'Compatibility contract must keep host plans advisory and outside close gates.'
    }
    $compatibilityHooks = $compatibility.lifecycle_hooks
    if ([string]$compatibilityHooks.role -ne 'opt-in-advisory' -or [bool]$compatibilityHooks.writes_state -or
        @($compatibilityHooks.events).Count -ne 3 -or -not [string]$compatibilityHooks.fallback) {
        Add-Fatal 'Compatibility contract must define opt-in, non-writing lifecycle hooks and fallback.'
    } elseif ($stateMachine) {
        $policyEvents = @($stateMachine.delivery_protocol.lifecycle_hooks.events | Sort-Object)
        $compatibilityEvents = @($compatibilityHooks.events | Sort-Object)
        if (($policyEvents -join '|') -ne ($compatibilityEvents -join '|')) {
            Add-Fatal 'Compatibility lifecycle hook events differ from the canonical policy.'
        }
    }
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
    if ([string]$nativePlan.schema_version -ne '3.0.0') { Add-Fatal 'Unexpected native-plan schema_version.' }
    if ([string]$nativePlan.scope -notmatch 'current-session-only' -or
        [string]$nativePlan.role -ne 'advisory-runtime-projection' -or
        [bool]$nativePlan.required_for_close -or
        [string]$nativePlan.availability -ne 'host-capability-dependent') {
        Add-Fatal 'Host-plan contract must describe an optional advisory projection.'
    }
    if (@($nativePlan.legacy_compatibility_tools).Count -ne 2) { Add-Fatal 'Native Plan contract must retain its two legacy compatibility tool names.' }
    if (-not $nativePlan.projection_scope) { Add-Fatal 'Native Plan contract must define projection_scope.' }
    foreach ($phase in @('route', 'setup', 'clarify', 'prototype', 'spec', 'tickets', 'goal', 'execute', 'review', 'close')) {
        if (-not $nativePlan.phase_mapping.PSObject.Properties[$phase]) { Add-Fatal "Native Plan mapping is missing phase: $phase" }
    }
}

if ($routeRecord) {
    if ([string]$routeRecord.schema_version -ne '2.0.0') { Add-Fatal 'Unexpected route-record schema_version.' }
    foreach ($field in @('run_id', 'flow', 'chosen_procedure', 'why', 'phase_sequence', 'confidence')) {
        if ($field -notin @($routeRecord.required_fields)) { Add-Fatal "Route-record required field is missing: $field" }
    }
    foreach ($confidence in @('low', 'medium', 'high')) {
        if ($confidence -notin @($routeRecord.confidence_values)) { Add-Fatal "Route-record confidence value is missing: $confidence" }
    }
}

if ($evidenceSchema) {
    if ([string]$evidenceSchema.schema_version -ne '2.0.0') { Add-Fatal 'Unexpected evidence schema_version.' }
    foreach ($field in @('evidence_id', 'acceptance_ids', 'type', 'result', 'artifact', 'artifact_digest', 'command_or_request_id', 'observed_at', 'producer', 'environment', 'delivery_generation', 'subject_digest')) {
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
foreach ($toolFile in @($nativePlanToolFile, $bridgeToolFile, $evidenceToolFile, $routeRecordToolFile, $metricsToolFile, $upgradeTestFile, $policySyncFile)) {
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

    if (-not $phaseBoundariesFile) { Add-Fatal 'Ask Matt phase-boundary reference is unavailable.' }
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
