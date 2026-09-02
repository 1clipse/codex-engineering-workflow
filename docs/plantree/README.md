# Plan Tree

Planning authority for `codex-engineering-workflow`.

## Authority

1. User intent and repository instructions.
2. Active plan scope and decisions.
3. Landed implementation and verification evidence.

## Baseline

- [Project baseline](baseline/README.md)

## Active Plans

| ID | Plan | Affected Modules | Status | Current Phase | Last Landed | Next Target |
| --- | --- | --- | --- | --- | --- | --- |
| P001 | [Engineering Workflow 2.0](plans/001-engineering-workflow-v2/README.md) | workflow, controller, packaging | Complete | Close | Installed `2.0.0+codex.20260825065211`; all local gates passed | User-owned commit/push/release decision |
| P002 | [Cross-Agent Portability](plans/002-cross-agent-portability/README.md) | workflow definition, adapters, controller, packaging | Complete | Close | JSON-authoritative host profiles, adapters and validation landed locally | User-owned commit/push/release decision |
| P003 | [Policy-Driven Delivery Protocol 3.0](plans/003-policy-driven-delivery-protocol-v3/README.md) | policy contract, controller harness, optional hooks, validation, documentation | Complete | Close | `delivery-control` 3.0.0 validated and enabled globally; [verification](plans/003-policy-driven-delivery-protocol-v3/evidence/verification-2026-09-02.md) | User-owned commit/push or a separately scoped future policy migration |

## Ideas

- [Inbox](ideas/inbox.md)
