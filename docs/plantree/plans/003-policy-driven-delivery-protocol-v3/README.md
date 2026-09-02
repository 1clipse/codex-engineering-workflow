# P003 - Policy-Driven Delivery Protocol 3.0

## Goal

Turn the workflow into a policy-driven delivery protocol: JSON is the versioned, machine-checkable structural rule source; Delivery Control is the deterministic enforcement and recovery layer; thin host instructions handle only routing and semantic judgement; optional Codex Hooks add lifecycle guardrails; Codex `/plan` and `/goal` remain session-local reasoning and execution facilities; Plan Tree remains the human-readable business authority.

## Scope

- Pin every flow to a policy identity, version, and digest, with explicit migration semantics.
- Add `standard` and `strict` policy modes without duplicating Codex's native agent loop.
- Ensure strict-mode escalation cannot be silently downgraded while an in-flight flow remains pinned to its policy.
- Derive controller enumerations and schemas from the canonical JSON policy.
- Limit Plan Tree consistency checks to the controlled state block and limit evidence artifacts to permitted project roots.
- Make host-plan projection an auditable, non-blocking runtime integration.
- Expose a concise normal MCP control surface while preserving only necessary compatibility paths internally.
- Add Codex Hook guidance for recovery, compact checkpoints, and close preflight.
- Preserve a manual, host-neutral fallback whenever a native Plan, Goal, or Hook is unavailable.

## Non-Goals

- Reimplement Codex `/plan`, `/goal`, approvals, sandboxing, review UI, or subagent runtime.
- Encode all semantic judgement as JSON or all policy mechanics as prompt text.
- Claim Hook coverage is a host-level security sandbox.
- Automatically grant, perform, or retry external effects.
- Invent unverified native capabilities for other Agent hosts.

## Acceptance

| ID | Criterion |
| --- | --- |
| AC-01 | Each flow records `policy_id`, `policy_version`, and `policy_digest`; a changed policy cannot silently reinterpret an existing flow. |
| AC-02 | Canonical JSON generates runtime values and schemas; duplicated state/action/phase truth is removed from the controller surface. |
| AC-03 | `standard` and `strict` modes are tested: standard stays light for ordinary engineering; strict adds multi-writer lease/fixed-point/recovery requirements; controlled external actions require exact authorization in every applicable mode. |
| AC-04 | Only a changed controlled state block causes consistency drift; evidence cannot resolve outside the configured project root. |
| AC-05 | Native host-plan support is an optional projection/attestation, never a close gate or an implied permission grant. |
| AC-06 | The regular MCP surface is concise and high-level; transactional detail stays internal. |
| AC-07 | Codex Hook integration is opt-in, has a safe documented manual fallback, and never claims to bypass Codex approval/sandbox behavior. |
| AC-08 | Automated tests cover policy pinning, mode rules, non-blocking plan projection, controlled-block drift, artifact escapes, recovery, and close gates. |

## Reading Path

- [Specification](topics/spec.md)
- [Decision: protocol layering](decisions/001-policy-harness-layering.md)
- [Roadmap](roadmap.md)
- [Implementation status](implementation-status.md)
- [Open questions](open-questions.md)
- [Verification evidence](evidence/README.md)
