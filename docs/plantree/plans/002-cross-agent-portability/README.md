# P002 - Cross-Agent Portability

## Goal

Make the workflow a JSON-authoritative, host-neutral delivery protocol that can run through thin adapters for Codex, Claude Code, OpenCode, Pi, dsh, zcode, and other standard-MCP hosts.

## Scope

- A canonical host-capability contract and JSON workflow definition.
- Generated or validated thin adapters for supported Agent configuration formats.
- A host-neutral Plan projection and explicit unsupported-capability handoff.
- Portable MCP configurations and installation guidance.
- Static and runtime checks that prevent adapter or policy drift.

## Non-Goals

- Claiming undocumented native features for an Agent host.
- Reimplementing any Agent's proprietary planning, task, approval, or subagent runtime.
- Removing every host instruction: hosts still need a minimal entrypoint to load the JSON contract and MCP server.
- Network services, remote state, telemetry, or automatic external actions.

## Acceptance

| ID | Criterion |
| --- | --- |
| AC-01 | One canonical JSON contract owns host capabilities, route/state authority, and adapter metadata; generated copies are drift-checked. |
| AC-02 | Codex, Claude Code, OpenCode, Pi, dsh, and zcode each have a documented, installable adapter or an explicit capability-gated generic-MCP fallback. |
| AC-03 | Adapter instructions contain only host bootstrap behavior; durable delivery policy remains in JSON and Delivery Control. |
| AC-04 | Native-plan synchronization is host-neutral and is confirmed only when the host supports a verified equivalent; all other hosts produce an explicit handoff. |
| AC-05 | Delivery Control remains local stdio MCP and works without a Codex plugin installation. |
| AC-06 | Automated validation covers canonical-policy drift, adapter completeness, known configuration shapes, and current controller regression tests. |

## Reading Path

- [Specification](topics/spec.md)
- [Roadmap](roadmap.md)
- [Implementation status](implementation-status.md)
- [Open questions](open-questions.md)
- [Verification evidence](evidence/verification-2026-08-26.md)
