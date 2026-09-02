---
name: engineering-workflow
description: Route non-trivial repository delivery through the versioned JSON policy, Plan Tree, and Delivery Control. Use plan-tree directly for planning-only maintenance and Product Design directly for design-only exploration.
---

# Engineering Workflow Loader

This is a thin host bootstrap, not the workflow specification. The canonical, versioned contract is [`references/state-machine.json`](references/state-machine.json), generated from `plugins/delivery-control/schemas/workflow-policy.json`.

## Authority and roles

- **JSON policy + Delivery Control**: machine-checked routes, transitions, delivery modes, evidence gates, policy pinning, recovery and external-action authorization.
- **Plan Tree**: durable product intent, scope, decisions, open questions and links to evidence. Its normal prose remains human-editable.
- **Host plan / goal**: optional, session-scoped thinking and execution view. It is never a transition or close gate.
- **This loader**: minimal semantic judgment—understand the request, choose a policy route, and request a genuinely user-owned decision.

Do not copy the JSON state machine into a long prompt. Read the policy, use the controller, and keep any host-specific instructions short.

## Normal delivery path

1. Read the policy, relevant Plan Tree state, repository instructions, and current Git state.
2. Call `audit_or_recover_flow` with `kind: "audit"`; if no flow exists, call `start_or_resume_flow`. If recovery is needed, use `kind: "recover"` before making a write.
3. Call `route_flow`. It derives phase order and automatically escalates to `strict` for declared external action, multi-agent, multi-host, release, production, or regulated work. Do not silently downgrade a strict flow.
4. At each meaningful boundary, update the Plan Tree decision/evidence and call `checkpoint_flow` or `record_evidence`. The controller owns state arithmetic and rejects stale revisions.
5. Use the host's native `/plan` or `/goal` only when it makes the current session easier to execute. Record `plan_sync: unavailable` and a concrete handoff when the host has no equivalent; continue from Plan Tree rather than blocking delivery.
6. Use `authorize_external_action` for an exact, short-lived, single-use authorization before every controlled external effect. This workflow does not grant commit, push, PR, deploy, tracker-write, production-data, credential, message, or costly-service authority.
7. Call `close_or_cancel_flow` only after evidence is registered. `close` reports structured unmet criteria until every policy gate and observable terminal condition pass.

## Procedure selection

After routing, read and apply the selected Ask Matt procedure manual for that phase when it is installed. Product Design is a focused design procedure, not a second state machine. Do not claim that an opt-in user Skill was automatically invoked when it was only read and applied.

## Safe fallback

If Delivery Control is unavailable, keep work in Plan Tree, state the missing controller capability and a concrete resume point, and do not report `complete` based solely on a host plan or agent assertion.
