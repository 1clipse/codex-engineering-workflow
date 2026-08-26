# P001 - Engineering Workflow 2.0

## Goal

Make delivery evidence generation-aware, prove external effects separately from authorization, reduce the normal MCP surface, derive progression from route templates, modularize the controller, generate policy assets from one source and verify behavior across processes and the real Codex host.

## Scope

- Delivery generation and fixed-point contracts.
- Evidence, Review and external-action result gates.
- High-level MCP operations and route-template progression.
- Controller module boundaries and generated policy assets.
- Cross-process, crash, path and Codex-host verification.
- Global Skill/plugin deployment and cachebuster reinstall.

## Non-Goals

- Executing external actions on behalf of the user.
- Replacing Plan Tree as business authority.
- Modifying Ask Matt, Plan Tree or Product Design upstream packages.
- Adding a network listener or remote telemetry.
- Preserving the 1.x low-level MCP surface as a public compatibility promise.

## Acceptance

| ID | Criterion |
| --- | --- |
| AC-01 | Scope changes create a new delivery generation and stale spec, implementation, Review and evidence cannot close it. |
| AC-02 | Every declared external action requires both a consumed exact authorization and a successful matching action result. |
| AC-03 | Normal MCP usage exposes constrained high-level operations; arbitrary transition patches are not public. |
| AC-04 | Route templates determine phase sequences and `next_phase` without caller-supplied skip arithmetic. |
| AC-05 | Controller responsibilities are split into focused modules behind the existing public class seam. |
| AC-06 | One canonical JSON policy generates runtime constants, schemas and workflow policy artifacts with drift detection. |
| AC-07 | Cross-process contention/crash/path tests and a Codex host/cache smoke test pass on this Windows machine. |

## Reading Path

- [Specification](topics/spec.md)
- [Roadmap](roadmap.md)
- [Implementation status](implementation-status.md)
- [Decision](decisions/001-generation-and-policy-authority.md)
- [Evidence](evidence/README.md)
