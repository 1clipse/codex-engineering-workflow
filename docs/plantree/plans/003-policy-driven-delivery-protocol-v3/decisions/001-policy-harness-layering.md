# Decision 001 - Policy and Harness Layering

## Decision

Use a hybrid model: JSON plus deterministic controller validation is authoritative for structural protocol rules; short host instructions are limited to routing and semantic judgement; Codex native Plan and Goal are runtime projections, not persistent workflow authority.

| Layer | Authority | Purpose |
| --- | --- | --- |
| User intent and Plan Tree | Durable business authority | Scope, decisions, acceptance criteria, rationale and evidence references |
| Canonical JSON plus Delivery Control | Machine-enforced protocol authority | Profiles, structural transitions, evidence shape, policy pinning, authorization and close gates |
| Thin host instruction | Semantic and routing aid | Interpret a request, collect a missing product decision, and invoke the controller |
| Native Plan/Goal and optional Hooks | Session ergonomics | Show a current plan, remind on lifecycle events, and create a recovery handoff |

## Rationale

A prompt alone can be truncated, reinterpreted, or ignored. JSON alone is only data unless code parses and enforces it. Codex already provides capable session reasoning, tool use, sandboxing, approvals, plans, goals, and Hooks. Recreating those facilities inside Delivery Control duplicates a mature harness and weakens cross-Agent portability.

## Consequences

- The Skill loader stays short and does not repeat policy rules.
- Plan Tree remains the durable explanation of what and why.
- The controller rejects invalid structural transitions and records durable evidence.
- `standard` remains the default operational profile; risk-signalled work escalates to `strict` and cannot be silently weakened during the flow.
- Native host plans improve execution ergonomics but cannot block a valid cross-Agent delivery from closing.
- Hooks supplement recovery and guardrails but are not claimed as a complete security boundary.
