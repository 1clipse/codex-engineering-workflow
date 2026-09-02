# Module Map

| Key | Surface | Responsibility |
| --- | --- | --- |
| workflow | `skills/engineering-workflow/` | Thin host bootstrap, routing context and semantic judgement; it does not duplicate the policy contract |
| controller | `plugins/delivery-control/src/` | Deterministic flow validation, transactions, recovery, close gates and MCP handlers |
| policy | `plugins/delivery-control/schemas/workflow-policy.json` and generated assets | Versioned source for routes, profiles, phases, schemas and runtime constants; generated copies are derived only |
| adapters | `adapters/` | Thin, host-specific MCP/bootstrap configuration with capability-gated fallbacks |
| hooks | `plugins/delivery-control/hooks/` when installed | Optional lifecycle reminders and diagnostics; never an approval or sandbox bypass |
| packaging | Plugin manifest, bundle and marketplace installation | Discovery and local runtime activation without remote workflow state |
| verification | JavaScript and PowerShell tests | Policy generation, public behavior, compatibility, recovery and packaging evidence |
