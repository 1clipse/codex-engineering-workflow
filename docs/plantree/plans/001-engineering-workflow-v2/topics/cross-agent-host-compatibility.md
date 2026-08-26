# Cross-Agent Host Compatibility Research

**Date:** 2026-08-26  
**Decision status:** research complete; adapter implementation is not yet authorized by this note.

## Conclusion

`delivery-control` is a standard local stdio MCP server, so hosts with a native
stdio MCP client can use the existing `dist/server.mjs` without changing its
protocol. The workflow's durable assets (Plan Tree, `AGENTS.md`, schemas and
evidence records) are host-neutral. Host-specific behavior must be isolated to
small configuration or adapter layers; do not fork workflow policy per client.

| Host | Native stdio MCP | Recommended integration | Confidence |
|---|---|---|---|
| Codex | Yes | Existing Codex plugin and MCP configuration | Implemented |
| Claude Code | Yes | `.mcp.json` / `claude mcp add` plus a Claude-facing skill adapter | Confirmed |
| OpenCode | Yes | `opencode.json` `mcp` entry plus OpenCode command/agent assets | Confirmed |
| Pi Coding Agent | No native client/config | Ship the shared skill and a small TypeScript extension that bridges stdio MCP tools to Pi tools | Confirmed limitation |
| DSH (DeepSeek Harness) | Yes | `@deepseek-ai/dsh-mcp-client` entry in `cordis.yml` | Confirmed |
| ZCode | Not established from official public material | Detect the installed version and its supported protocol before offering an adapter; fall back to shared Markdown assets | Unconfirmed |

The request's `dsh.zcode` is most plausibly two clients with missing punctuation:
**DSH** (DeepSeek Harness) and **ZCode**. They should not be treated as one
product or given the same support claim.

## Confirmed Host Formats

### Claude Code

Anthropic documents stdio MCP registration through the CLI. The `--` delimiter
separates Claude CLI options from the server command:

```bash
claude mcp add --scope user --transport stdio delivery-control -- \
  node /absolute/path/to/dist/server.mjs
```

For a shareable project configuration, use `--scope project` or a project-root
`.mcp.json`:

```json
{
  "mcpServers": {
    "delivery-control": {
      "command": "node",
      "args": ["/absolute/path/to/dist/server.mjs"]
    }
  }
}
```

`--scope user` stores user-wide configuration in `~/.claude.json`. Keep the
server path machine-local; a committed project example should use a documented
installation variable or setup script rather than a personal absolute path.

**Primary source:** [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp).

### OpenCode

OpenCode calls a local process by declaring `type: "local"` under `mcp`; this
is its stdio transport. It merges global and project configuration, with the
project-root `opencode.json` taking precedence over
`~/.config/opencode/opencode.json`.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "delivery-control": {
      "type": "local",
      "command": ["node", "/absolute/path/to/dist/server.mjs"],
      "cwd": "/workspace/project",
      "enabled": true
    }
  }
}
```

The official options also include `environment` and `timeout`. Use the project
config for an intentional project adapter; use the global config only for a
user's local server path and preferences.

**Primary sources:** [OpenCode MCP servers](https://opencode.ai/docs/mcp-servers), [OpenCode configuration](https://opencode.ai/docs/config), and the [versioned documentation source](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/mcp-servers.mdx).

### Pi Coding Agent

Pi supports Agent Skills and TypeScript extensions but deliberately has **no
native MCP client** or declarative stdio-MCP configuration. Its official README
states this explicitly. It can load shared skills from
`~/.pi/agent/skills/`, `~/.agents/skills/`, `.pi/skills/` or `.agents/skills/`;
extensions load from the analogous `extensions/` paths and can be reloaded with
`/reload`.

Therefore Pi compatibility needs two layers:

1. Package the host-neutral workflow instructions as an Agent Skills-compatible
   `SKILL.md` plus Plan Tree references.
2. Implement and test a Pi TypeScript extension that starts the existing stdio
   server and registers bridged tool calls with Pi's extension API.

Do not advertise a JSON-only Pi setup or native `delivery-control` MCP support
until that bridge exists and is smoke-tested.

**Primary sources:** [Pi coding-agent README](https://github.com/earendil-works/pi/tree/main/packages/coding-agent), [Pi extension documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md), [Pi settings and resource locations](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md).

### DSH (DeepSeek Harness)

DeepSeek Harness provides a native MCP client plugin. One `cordis.yml` entry
represents one MCP server:

```yaml
- id: delivery-control
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: delivery-control
    transport: stdio
    command: node
    args: ['/absolute/path/to/dist/server.mjs']
    cwd: /workspace/project
```

The plugin projects tools as `mcp__delivery-control__<tool>`. Use one generated
DSH profile fragment per project/environment and never include credentials in
the generated file.

**Primary sources:** [DeepSeek Harness repository](https://github.com/deepseek-ai/deepseek-harness), [official `dsh-mcp-client` README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md).

### ZCode

ZCode likely means the Z.ai/GLM desktop coding product, but no official public
MCP client schema, plugin SDK, or stable CLI configuration reference was found
in this research. Community wrappers are not protocol authority and must not
be used to assert compatibility.

Until the exact product/version and official integration contract are known:

- offer the host-neutral assets only (`AGENTS.md`, Plan Tree, Markdown skill
  instructions and schemas);
- run a non-mutating capability probe for MCP, ACP, plugins and skill loading;
- generate a ZCode adapter only after the probe identifies a supported official
  protocol.

## Implementation Recommendation

Create an `adapters/` package with a single canonical host-neutral policy input
and generated, reviewable assets:

- `adapters/claude-code/`: `.mcp.json` template and Claude skill/command entry.
- `adapters/opencode/`: `opencode.json` fragment and OpenCode agent/command entry.
- `adapters/pi/`: Agent Skills package plus the required stdio MCP bridge extension.
- `adapters/dsh/`: `cordis.yml` plugin fragment.
- `adapters/zcode/`: capability probe only, marked experimental until official
  protocol evidence exists.

The generator must require an explicit project root and `delivery-control`
server path, produce no secrets, and validate generated JSON/YAML. All
adapters must preserve the existing rule: the controller validates workflow
state and authorization, but never gains authority to commit, push, deploy,
send external messages, or access credentials.

## Acceptance Criteria For A Future Adapter Change

- Every direct-MCP host completes an isolated stdio `initialize` and tool-list
  smoke test using its generated configuration.
- Pi completes the same test through its extension bridge, including clean
  shutdown and `/reload` behavior.
- Generated configuration has no credential values and no personal absolute
  paths committed to the repository.
- The host UI/CLI recognizes the workflow instructions and Plan Tree remains
  the sole durable project-planning authority.
- ZCode remains excluded from the supported-host list unless a reproducible
  official protocol source and a passing smoke test are recorded.
