# Cross-Agent Adapters

`plugins/delivery-control/schemas/workflow-policy.json` is the canonical workflow definition. The generated files in this directory only describe how a host reaches the local controller; they do not duplicate delivery rules.

## Support Matrix

| Host | Status | Integration |
| --- | --- | --- |
| Codex | Native | Codex plugin and Skill package |
| Claude Code | Native MCP | Generated `.mcp.json` fragment and thin Skill bootstrap |
| OpenCode | Native MCP | Generated `opencode.json` fragment and thin command bootstrap |
| Pi | Bridge | Agent Skill plus local TypeScript stdio-MCP bridge |
| DSH | Native MCP | Generated `cordis.yml` fragment |
| ZCode | Probe required | Capability probe plus shared `AGENTS.md`/Plan Tree assets |

## Generate A Local Configuration

Run the installer from the repository root. It writes a separate configuration fragment by default, so it never overwrites an existing host configuration.

```powershell
./adapters/install-adapter.ps1 -Host claude-code
./adapters/install-adapter.ps1 -Host opencode
./adapters/install-adapter.ps1 -Host dsh
```

Merge the generated fragment into the host-owned configuration only after reviewing its absolute server path. Pi uses the packaged bridge at `adapters/pi/`; ZCode must pass its capability probe before any native configuration is created.

## Host Bootstrap

Each host bootstrap has one responsibility: load the canonical JSON definition and work through the seven high-level `delivery-control` operations. Plan Tree remains the durable planning authority. A host-native plan is optional session guidance; when absent, record a concrete handoff but never block evidence-based closure solely for lack of a host plan.

Official integration references are recorded in [the compatibility research](../docs/plantree/plans/001-engineering-workflow-v2/topics/cross-agent-host-compatibility.md).
