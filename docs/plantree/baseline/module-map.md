# Module Map

| Key | Surface | Responsibility |
| --- | --- | --- |
| workflow | `skills/engineering-workflow/` | Routing, procedure selection and delivery contract |
| controller | `plugins/delivery-control/src/` | Flow state, transactions, recovery, gates and MCP handlers |
| policy | Delivery Control policy plus generated assets | Route templates, phases, schemas and runtime constants |
| packaging | Plugin manifest, bundle and marketplace installation | Codex discovery and local runtime activation |
| verification | JavaScript and PowerShell tests | Public behavior, compatibility and packaging evidence |
