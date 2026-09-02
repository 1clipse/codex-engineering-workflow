param(
    [string]$SourceSkillsRoot = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent),
    [string]$SourceWorkflowRoot = (Split-Path $PSScriptRoot -Parent),
    [string]$SourceAgentsFile = (Join-Path (Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent) 'AGENTS.md'),
    [string]$SourceProductDesignRoot,
    [string]$SourceDeliveryPluginRoot = (Join-Path (Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent) 'plugins\delivery-control'),
    [string]$SourceAdaptersRoot = (Join-Path (Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent) 'adapters')
)

$ErrorActionPreference = 'Stop'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("engineering-workflow-tests-" + [guid]::NewGuid().ToString('N'))
$fixtureSkills = Join-Path $testRoot 'skills'
$fixtureAgents = Join-Path $testRoot 'AGENTS.md'
$fixtureDesign = Join-Path $testRoot 'product-design'
$fixturePlugin = Join-Path $testRoot 'delivery-control'
$fixtureAdapters = Join-Path $testRoot 'adapters'
$failures = New-Object System.Collections.Generic.List[string]

function Restore-Text([string]$Path, [string]$Content) {
    [IO.File]::WriteAllText($Path, $Content, (New-Object Text.UTF8Encoding($false)))
}

function Invoke-Validator {
    $validator = Join-Path $fixtureSkills 'engineering-workflow\scripts\validate.ps1'
    $output = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $validator `
        -SkillsRoot $fixtureSkills -WorkflowRoot (Join-Path $fixtureSkills 'engineering-workflow') `
        -AgentsFile $fixtureAgents -ProductDesignRoot $fixtureDesign -DeliveryPluginRoot $fixturePlugin -AdaptersRoot $fixtureAdapters 2>&1)
    [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = ($output -join "`n") }
}

function Assert-Case([string]$Name, [scriptblock]$Mutate, [string]$Pattern) {
    & $Mutate
    $result = Invoke-Validator
    if ($result.ExitCode -ne 1 -or $result.Output -notmatch $Pattern) {
        $failures.Add("$Name expected exit 1 /$Pattern/; got $($result.ExitCode): $($result.Output)")
    } else { Write-Output "PASS CASE: $Name" }
}

try {
    [void][IO.Directory]::CreateDirectory($fixtureSkills)
    if (-not (Test-Path -LiteralPath (Join-Path $SourceSkillsRoot 'ask-matt\SKILL.md') -PathType Leaf)) {
        $globalSkills = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\skills'
        if (Test-Path -LiteralPath (Join-Path $globalSkills 'ask-matt\SKILL.md') -PathType Leaf) { $SourceSkillsRoot = $globalSkills }
    }
    if (-not $SourceProductDesignRoot) {
        $codexRoot = Split-Path $SourceSkillsRoot -Parent
        $root = Join-Path $codexRoot 'plugins\cache\openai-curated-remote\product-design'
        $SourceProductDesignRoot = (Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1).FullName
        if (-not $SourceProductDesignRoot) {
            foreach ($candidatePath in @(
                (Join-Path $codexRoot '.tmp\plugins\plugins\product-design'),
                (Join-Path $codexRoot '.tmp\plugins-remote\plugins\product-design')
            )) {
                if (Test-Path -LiteralPath (Join-Path $candidatePath '.codex-plugin\plugin.json') -PathType Leaf) {
                    $SourceProductDesignRoot = $candidatePath
                    break
                }
            }
        }
    }
    Copy-Item $SourceProductDesignRoot $fixtureDesign -Recurse
    Copy-Item $SourceDeliveryPluginRoot $fixturePlugin -Recurse
    Copy-Item $SourceAdaptersRoot $fixtureAdapters -Recurse
    $askMatt = Get-Content (Join-Path $SourceSkillsRoot 'ask-matt\SKILL.md') -Raw
    $skills = @([regex]::Matches($askMatt, '`/(?<name>[a-z][a-z0-9-]+)(?:\s[^`]*)?`') | ForEach-Object { $_.Groups['name'].Value } | Where-Object { $_ -notin @('clear','compact') } | Sort-Object -Unique)
    $skills += @('ask-matt','plan-tree','engineering-workflow')
    foreach ($skill in @($skills | Sort-Object -Unique)) {
        $source = if ($skill -eq 'engineering-workflow') { $SourceWorkflowRoot } else { Join-Path $SourceSkillsRoot $skill }
        Copy-Item $source (Join-Path $fixtureSkills $skill) -Recurse
    }
    Copy-Item $SourceAgentsFile $fixtureAgents

    $baseline = Invoke-Validator
    if ($baseline.ExitCode -ne 0) { throw "Fixture baseline failed: $($baseline.Output)" }
    Write-Output 'PASS CASE: complete baseline'

    $workflow = Join-Path $fixtureSkills 'engineering-workflow\SKILL.md'
    $ui = Join-Path $fixtureSkills 'engineering-workflow\agents\openai.yaml'
    $version = Join-Path $fixtureSkills 'plan-tree\VERSION'
    $manifest = Join-Path $fixturePlugin '.codex-plugin\plugin.json'
    $mcpConfig = Join-Path $fixturePlugin '.mcp.json'
    $server = Join-Path $fixturePlugin 'dist\server.mjs'
    $policy = Join-Path $fixturePlugin 'schemas\workflow-policy.json'
    $flowStateSchema = Join-Path $fixturePlugin 'schemas\flow-state.schema.json'
    $hookTemplate = Join-Path $fixturePlugin 'hooks\hooks.json.template'
    $hookScript = Join-Path $fixturePlugin 'hooks\lifecycle-advisory.mjs'
    $bridge = Join-Path $fixtureSkills 'engineering-workflow\scripts\plan-tree-bridge.ps1'
    $adapterCapabilities = Join-Path $fixtureAdapters 'host-capabilities.json'
    $stateMachine = Join-Path $fixtureSkills 'engineering-workflow\references\state-machine.json'
    $compatibility = Join-Path $fixtureSkills 'engineering-workflow\references\compatibility.json'
    $nativePlan = Join-Path $fixtureSkills 'engineering-workflow\references\native-plan.json'
    $designQa = Join-Path $fixtureDesign 'skills\design-qa\SKILL.md'
    $originals = @{}
    foreach ($path in @($workflow,$ui,$version,$manifest,$mcpConfig,$server,$policy,$flowStateSchema,$hookTemplate,$hookScript,$bridge,$fixtureAgents,$adapterCapabilities,$stateMachine,$compatibility,$nativePlan)) { $originals[$path] = Get-Content $path -Raw }

    Move-Item $designQa "$designQa.missing"
    Assert-Case 'missing Product Design Skill' {} 'Product Design focused Skill is missing: design-qa'
    Move-Item "$designQa.missing" $designQa

    $dependency = Join-Path $fixtureSkills 'to-spec\SKILL.md'; Move-Item $dependency "$dependency.missing"
    Assert-Case 'missing Ask Matt dependency' {} 'Ask Matt referenced Skill is missing: to-spec'
    Move-Item "$dependency.missing" $dependency

    Assert-Case 'outdated Plan Tree' { Restore-Text $version "0.3.9`n" } 'Plan Tree 0.4.0 or newer is required'; Restore-Text $version $originals[$version]
    Assert-Case 'duplicate markers' { Restore-Text $fixtureAgents ($originals[$fixtureAgents] + "`n<!-- plan-tree:instructions:start -->`n<!-- plan-tree:instructions:end -->") } 'exactly one Plan Tree marker pair'; Restore-Text $fixtureAgents $originals[$fixtureAgents]
    Assert-Case 'bad frontmatter' { Restore-Text $workflow ($originals[$workflow] -replace '\A---','bad') } 'frontmatter delimiters are invalid'; Restore-Text $workflow $originals[$workflow]
    Assert-Case 'bad UI metadata' { Restore-Text $ui "interface:`n  display_name: test`n" } 'interface.short_description'; Restore-Text $ui $originals[$ui]
    Assert-Case 'broken relative reference' { Restore-Text $workflow ($originals[$workflow] + "`n[bad](missing.md)`n") } 'Broken relative Markdown link'; Restore-Text $workflow $originals[$workflow]
    Assert-Case 'missing planning trigger boundary' { Restore-Text $workflow ($originals[$workflow].Replace('Use plan-tree directly','Route elsewhere')) } 'planning-only maintenance directly to plan-tree'; Restore-Text $workflow $originals[$workflow]
    Assert-Case 'missing JSON loader contract' { Restore-Text $workflow ($originals[$workflow].Replace('checkpoint_flow','removed-transition')) } 'Workflow loader is missing: checkpoint_flow'; Restore-Text $workflow $originals[$workflow]
    Assert-Case 'adapter capability drift' { Restore-Text $adapterCapabilities ($originals[$adapterCapabilities].Replace('"codex"','"wrong"')) } 'Generated adapter host capabilities differ'; Restore-Text $adapterCapabilities $originals[$adapterCapabilities]
    Assert-Case 'invalid plugin identity' { Restore-Text $manifest ($originals[$manifest].Replace('"name": "delivery-control"','"name": "wrong"')) } 'manifest has the wrong name'; Restore-Text $manifest $originals[$manifest]
    Assert-Case 'unresolved MCP root' { Restore-Text $mcpConfig ($originals[$mcpConfig].Replace('./dist/server.mjs','${PLUGIN_ROOT}/dist/server.mjs')) } 'plugin-relative ./dist/server.mjs entrypoint'; Restore-Text $mcpConfig $originals[$mcpConfig]
    Assert-Case 'missing MCP tool' { Restore-Text $server ($originals[$server].Replace('authorize_external_action','removed_authorization_tool')) } 'MCP tool is missing: authorize_external_action'; Restore-Text $server $originals[$server]
    Assert-Case 'legacy MCP tool exposed' { Restore-Text $server ($originals[$server] + [Environment]::NewLine + 'register("inspect_flow"') } 'public interface has unexpected tool: inspect_flow'; Restore-Text $server $originals[$server]
    Assert-Case 'canonical policy identity drift' { Restore-Text $policy ($originals[$policy].Replace('com.1clipse.policy-driven-delivery-protocol','wrong-policy')) } 'Generated workflow state-machine.json differs'; Restore-Text $policy $originals[$policy]
    Assert-Case 'generated policy state schema drift' { Restore-Text $flowStateSchema ($originals[$flowStateSchema].Replace('"policy_id",','"policy_identity",')) } 'Generated flow-state schema required field is missing: policy_id'; Restore-Text $flowStateSchema $originals[$flowStateSchema]
    Assert-Case 'host plan hard gate' {
        Restore-Text $policy ($originals[$policy].Replace('"required_for_close": false','"required_for_close": true'))
        Restore-Text $stateMachine ($originals[$stateMachine].Replace('"required_for_close": false','"required_for_close": true'))
    } 'must mark host plans advisory'; Restore-Text $policy $originals[$policy]; Restore-Text $stateMachine $originals[$stateMachine]
    Assert-Case 'native plan hard gate' { Restore-Text $nativePlan ($originals[$nativePlan].Replace('"required_for_close": false','"required_for_close": true')) } 'Host-plan contract must describe an optional advisory projection'; Restore-Text $nativePlan $originals[$nativePlan]
    Move-Item $hookScript "$hookScript.missing"
    Assert-Case 'missing lifecycle hook script' {} 'Delivery Control lifecycle hook script is missing'
    Move-Item "$hookScript.missing" $hookScript
    Assert-Case 'unsafe lifecycle hook capability' { Restore-Text $hookScript ($originals[$hookScript] + "`nfetch('https://example.invalid')") } 'pure advisory transform; found forbidden capability: fetch\('; Restore-Text $hookScript $originals[$hookScript]
    Assert-Case 'legacy write path enabled' { Restore-Text $bridge ($originals[$bridge].Replace('Legacy Plan Tree writes are disabled','writes enabled')) } 'legacy Plan Tree bridge still exposes a write path'; Restore-Text $bridge $originals[$bridge]

    if ($failures.Count) {
        foreach ($failure in $failures) { Write-Output "FAIL CASE: $failure" }
        Write-Output "FAIL: $($failures.Count) validator test case(s) failed."
        exit 1
    }
    Write-Output 'PASS: all validator fault-injection tests passed.'
    exit 0
} finally {
    if (Test-Path $testRoot) { Remove-Item $testRoot -Recurse -Force }
}
