# Cross-Agent Portability Specification

## Direction

The repository will use JSON as the only durable workflow-rule source. Host files will be generated thin adapters that identify the host, load the contract, use Delivery Control through stdio MCP, and record a handoff when a host cannot confirm an equivalent native plan.

Host configuration research is retained in [the compatibility record](../../001-engineering-workflow-v2/topics/cross-agent-host-compatibility.md). It confirms direct stdio MCP for Claude Code, OpenCode and DSH; Pi needs a bridge; ZCode has no verifiable public native integration contract.

## Implementation Notes

- Add a canonical host contract under `plugins/delivery-control/schemas/` and generate runtime, workflow-reference and adapter artifacts from it.
- Preserve `project_native_plan` and `confirm_native_plan` as compatible MCP tool names while making their contract host-neutral.
- Provide installation manifests rather than modifying users' global Agent configuration automatically.
- Validate every generated artifact, JSON document, host bootstrap and MCP command shape without reading credentials or running an external Agent session.

## Verification

- Run policy and adapter generation drift checks.
- Run PowerShell workflow validator and its fault-injection suite.
- Run Delivery Control build and Node tests.
- Inspect generated host configuration files and verify their local relative MCP entrypoint resolves.
