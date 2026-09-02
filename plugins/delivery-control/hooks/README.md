# Optional Codex lifecycle hooks

This directory is an **opt-in advisory layer** for Codex sessions. It preserves no workflow data and cannot make a managed flow complete, authorize an external action, or change a Plan Tree record.

The implementation deliberately does only this:

- reads the hook event JSON from standard input;
- returns a small lifecycle reminder on standard output; and
- exits successfully, including for malformed or unknown input.

It does not read a conversation transcript, call MCP, write SQLite, change a Plan Tree file, use a credential, or contact the network. The controller remains the only path for state transitions and authorization receipts.

## Enable deliberately

`hooks.json.template` is not named `hooks.json` on purpose: installing or updating this plugin must not silently activate a hook. To enable it for one trusted project:

1. Copy the template into `<project>/.codex/hooks.json`.
2. Replace every `<ABSOLUTE-DELIVERY-CONTROL-PLUGIN-ROOT>` placeholder with the absolute path to this plugin directory.
   Use forward slashes on Windows as well, for example `C:/Users/Administrator/plugins/delivery-control`.
3. Keep only one hook configuration representation in that configuration layer (either `hooks.json` or inline `config.toml` hooks).
4. Review and trust the project hook when Codex asks.

For a user-wide setup, place the edited file at `~/.codex/hooks.json` instead. Do not place it in a shared or untrusted repository without reviewing the command first.

The template handles:

| Event | Advisory behavior |
| --- | --- |
| `SessionStart` | Reminds the agent to audit or resume a managed flow before mutating it. |
| `PreCompact` | Reminds the agent to preserve flow ID, revision, Plan Tree path, resume point, and unresolved gates. |
| `Stop` | Reminds the agent that ending a turn is not proof of delivery completion. |

The command is intentionally not registered in the plugin's default `hooks/hooks.json` location. That makes activation explicit and keeps this layer compatible with hosts or installations that do not support Codex hooks.

## Optional flow hint

Set `DELIVERY_CONTROL_FLOW_ID` in the environment only when a stable, non-sensitive flow ID is already known. The hook validates the ID before echoing it in a reminder. It never discovers, stores, or trusts a flow ID on its own.

## Fallback without hooks

On a host without lifecycle hooks, use the same checkpoints manually:

- start or resume: audit/recover the flow before a state-changing action;
- before context compaction or handoff: persist the current Plan Tree resume point and outstanding gates through the controller; and
- before reporting completion: run the controller's close gate.

Hooks are a context-safety aid, not a policy-enforcement sandbox. The active agent still needs to use Delivery Control and obey the user's authorization boundaries.

## Source basis

Codex hooks may be configured via `hooks.json` or inline `config.toml`, and plugin hooks are subject to the same review/trust model. `SessionStart`, `PreCompact`, and `Stop` accept the JSON response fields used by this script. See the official [Codex Hooks documentation](https://learn.chatgpt.com/docs/hooks).
