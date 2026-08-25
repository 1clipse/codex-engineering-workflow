---
name: engineering-workflow
description: Route non-trivial repository work from a feature, hard bug, research result, architecture idea, or UI/UX product change through planning and verified delivery. Use for work needing clarification, specification, visual design, execution, multi-session recovery, or release readiness. Use plan-tree directly for planning-only maintenance and Product Design directly for design-only exploration.
---

# Engineering Workflow

Own delivery from request to verified terminal evidence. Use Ask Matt for phase procedures, Product Design for visual work, Plan Tree as the durable authority, `delivery-control` for transactions and gates, and the native Codex plan only as a current-session projection. No phase artifact is completion by itself.

## 1. Route And Initialize

Inspect project instructions, Git state, relevant implementation, tracker configuration, and active `docs/plantree/` state. Apply this authority order:

1. User intent and repository instructions.
2. Safety and external-action permissions.
3. Forced procedures: named Skill, active merge conflict, hard bug, human-only step, or approved execution contract.
4. Recorded Plan Tree state.
5. Ask Matt.

For non-trivial unforced delivery, read `../ask-matt/SKILL.md` and apply its selected procedure manual. Skip this workflow for a one-line answer, a low-risk local edit without durable decisions, pure Plan Tree maintenance, or design-only exploration.

Use the `delivery-control` MCP server for every durable flow. On a new flow, call `initialize_flow` against an existing Plan Tree current-state file. Declare stable acceptance IDs, required evidence types, terminal condition, external actions, and resume point. On an existing flow, call `inspect_flow`, `recover_flow`, and `audit_consistency` before routing. Never write the controlled state block directly.

Prefer `start_or_resume_flow`, `advance_flow`, `record_delivery_evidence`, `record_review_findings`, and `close_verified_flow` for normal work. Keep `propose_transition`, `commit_transition`, and other low-level tools for diagnostics, explicit recovery, or a consequential change that needs a separate proposal.

Persist this contract through the controller:

```text
flow_id, revision
flow: main | bug | triage | wayfinder | maintenance | direct
status: active | awaiting-user | blocked-external | partial | failed | complete | cancelled
current_phase: route | setup | clarify | prototype | spec | tickets | goal | execute | review | close
next_phase, plan_target, terminal_condition, resume_point
acceptance_criteria[], required_evidence_types[], external_actions[]
terminal_observation?, review_findings[]
```

Call `select_route` with the chosen procedure, reason, skipped phases, setup requirement, and confidence. Every skipped phase must be named explicitly; the controller rejects an undeclared jump. A low-confidence route remains `awaiting-user` until the route choice is confirmed.

The controller rejects skipped phases that are required by the selected flow. `spec` may only be omitted when the route records an explicitly approved imported spec. `execute` and `review` are never silently skippable. A phase completed earlier in the same flow remains satisfied when scope changes send work back to `clarify`; do not reclassify completed work as skipped.

## 2. Select Phase Procedures

Default progression:

```text
route -> setup when required -> clarify/grill -> prototype when runnable evidence is needed
-> spec -> tickets for sliced or parallel work -> goal -> execute -> review -> close
```

Read the selected `../<procedure>/SKILL.md` completely and apply it as the phase manual. The procedure cannot expand permissions.

For incomplete tracker setup, preserve the current state, enter `setup`, read `../setup-matt-pocock-skills/SKILL.md`, initialize only the route-required configuration, re-read it, and resume. When durable planning is needed, read `../plan-tree/SKILL.md`, choose one mode, and obey its write boundary.

For Product Design work, load the installed Product Design router and its focused Skill. Run `user-context` before every design route and `get-context` before ideation or building. Generate three directions only for a new visual direction and wait for selection. Use `image-to-code`, `url-to-code`, or `prototype` for an existing visual source. Require `design-qa.md` with `final result: passed` before implementation handoff. Audit-only work may close after audit evidence; audit plus build continues into specification and execution.

Tell the user the flow and phase in one sentence. Ask only for product decisions, acceptance, credentials, new authority, destructive actions, external communication, release, or production impact.

## 3. Transact Every Boundary

Every controller write uses the latest `expected_revision` and a SHA-256 `request_digest` of the exact request. Use `propose_transition` when the change is consequential or needs review, then `commit_transition`. Revision conflict requires reinspection; do not replay stale input.

Authorization has two distinct digests: the exact external action digest and the controller mutation digest. They must not be reused as aliases. A consumed receipt carries both, and recovery reconciles a receipt that was projected before the authorization row was marked consumed.

New flows must start at `route -> clarify`. A non-direct flow cannot enter `execute` without a recorded `spec` phase (or an explicitly imported approved spec), and cannot enter `close` without a recorded `review` phase.

Before crossing a phase boundary:

1. Record new decisions, questions, scope and evidence links in their authoritative Plan Tree/tracker/ADR locations.
2. Commit the controller transition.
3. Call `project_native_plan`.
4. Apply the exact projection with Codex `update_plan`.
5. Call `confirm_native_plan`; when unavailable, record an explicit handoff fallback.

At context boundaries apply `../ask-matt/PHASE-BOUNDARIES.md`. Fork only from approved `SPEC READY` with explicit user authorization and supported task tooling. Use `to-goal` for multi-session, parallel, delayed, or noisy-context execution. Correlate child work with `flow_id`, `correlation_id`, and `receipt_digest`.

Exceptional transitions:

| Event | Required state |
| --- | --- |
| `SPEC NOT READY` | Stay `active`; return to `clarify` or `spec`; record missing decisions. |
| Several frontier tickets | `awaiting-user` in `tickets`; request one frontier without silently merging. |
| External prerequisite | `blocked-external`; record the concrete blocker. |
| Partial result | `partial`; preserve verified work and make every gap a completion criterion. |
| Execution needs authority | `awaiting-user` in `execute`; request the smallest missing authority. |
| Unrecoverable error or failed fork | `failed`, `next_phase: none`; preserve evidence and avoid automatic retry. |
| Review P0/P1 | Return to `execute`, then repeat review from the recorded fixed point. |
| Scope or architecture change | Return to `route`; update Plan Tree decisions, scope, roadmap and evidence first. |
| User cancellation | `cancelled`, `next_phase: none`; preserve the safe resume point. |

When drift, a crash journal, stale native Plan, authorization failure, or completion-gate failure appears, load `$delivery-control` automatically. Plan Tree wins authority conflicts; freeze and report drift instead of overwriting it.

## 4. Preserve Authority And Permission

- `CONTEXT.md` owns domain language.
- `docs/adr/` owns hard-to-reverse architecture rationale.
- The tracker or `.scratch/` owns specs, tickets, acceptance criteria, blockers, and execution units.
- Plan Tree owns plan identity, lifecycle, scope, flow state, roadmap, decisions, questions, handoff, and evidence links.
- SQLite owns only WAL, pending transactions, leases, digests, authorization consumption, metrics, and recovery metadata.

This workflow never grants commit, push, PR, merge, deploy, tracker mutation, production-data access, credential access, external messages, or costly service calls. For each exact external action call `request_authorization`; prefer MCP elicitation, otherwise require the user to return the challenge code. Call `consume_authorization` immediately before the action. Receipts, inherited summaries and tracker labels carry information, not authority. Codex action-time confirmation remains mandatory.

## 5. Verify And Close

Record evidence with `record_delivery_evidence` (or `validate_evidence` for low-level recovery). Every item needs `evidence_id`, `acceptance_ids[]`, type, passing result, artifact, SHA-256 artifact digest, command/request ID, observation time, producer, environment, and optional supersession/expiry. Relative artifact paths resolve from `plan_root` and are normalized before persistence.

Review must be recorded with `record_review_findings`. Every finding needs a disposition; findings cannot be silently removed; P0/P1 findings must be fixed and include a re-verifier. Completion requires a `terminal_observation` that points to a current valid evidence record with the same artifact and digest.

Call `close_flow` only after verification and review. It may set `complete/close/none` only when:

- every acceptance ID has current valid evidence;
- all required test, review, design or deployment evidence types exist;
- artifacts exist and their digests match;
- evidence is current and failed or unresolved findings are absent;
- external actions have consumed authorization receipts;
- each external action receipt matches action, target, environment, and its exact request digest;
- Plan Tree and the transaction journal agree;
- native Plan is confirmed or explicitly unavailable with a handoff;
- the observable terminal condition has been verified.

On failure, retain the accurate non-terminal state and report `unmet_criteria`. On success, report flow ID/revision, changed artifacts, evidence, external effects, worktree state, and terminal receipt. Use controller metrics only for aggregate counts; never log prompts, credentials, or sensitive payloads.
