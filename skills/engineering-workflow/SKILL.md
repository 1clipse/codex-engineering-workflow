---
name: engineering-workflow
description: Route non-trivial repository delivery through the canonical JSON contract, Plan Tree, and Delivery Control. Use plan-tree directly for planning-only maintenance and Product Design directly for design-only exploration.
---

# Engineering Workflow Loader

`references/state-machine.json` is the generated copy of the canonical workflow definition at `plugins/delivery-control/schemas/workflow-policy.json`. JSON is authoritative for route templates, state transitions, authority boundaries, evidence, completion gates and host capabilities. This file is only the host bootstrap.

## Bootstrap

1. Read the canonical JSON definition and `references/host-capabilities.json`.
2. Inspect repository instructions, Plan Tree, Git state and the active flow. Plan Tree owns durable business state.
3. Select one listed flow. If task intent cannot establish the route with high confidence, keep the flow `awaiting-user` and request the smallest decision.
4. Start or resume through `delivery-control`; use only its high-level operations for durable state.
5. Apply an installed Ask Matt procedure only for the selected phase. Product Design remains a focused UI/UX procedure, not a second delivery state machine.

## Boundary Execution

For every boundary, record Plan Tree decisions and evidence first; then call `advance_phase`. Ask `project_native_plan` for a host-plan projection. Confirm only an equivalent plan actually applied by the active host. Otherwise call `confirm_native_plan` with `available: false` and a concrete handoff.

Do not report `complete` until `close_flow` passes every JSON-defined gate. The controller rejects invalid phase arithmetic, stale revisions, missing evidence, unresolved Review findings, unauthorized external actions and inconsistent Plan Tree state.

External effects remain user-authorized: the JSON definition lists controlled action classes, while `request_authorization`, `consume_authorization` and `record_external_action_result` bind each exact attempt. No host bootstrap grants external authority.
