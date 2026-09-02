---
name: delivery-control
description: Audit, recover, checkpoint, authorize, or close a JSON-policy-controlled engineering delivery flow. Use manually for diagnostics and recovery, or when engineering-workflow detects drift, a journal, authorization failure, or an unmet close gate. Do not use as the normal feature-delivery router.
---

# Delivery Control

Delivery Control is the local enforcement layer for the canonical JSON policy. Plan Tree owns durable product meaning; SQLite/WAL is a rebuildable transaction journal, lease store, authorization ledger and evidence index.

Use the seven public operations only:

1. `start_or_resume_flow` — create a policy-pinned flow or recover an interrupted start.
2. `route_flow` — select the controller-derived route and delivery mode.
3. `checkpoint_flow` — progress a phase, record a scope change, migrate policy explicitly, or resolve restored drift.
4. `record_evidence` — record delivery evidence or review dispositions.
5. `authorize_external_action` — request, confirm, consume, and record one exact external action.
6. `audit_or_recover_flow` — inspect consistency or reconcile a journal.
7. `close_or_cancel_flow` — close with verified evidence or preserve an explicit cancellation.

## Rules

- Audit before mutation when resuming, after a crash, or when a handoff is uncertain. A stale revision means another writer won; inspect again rather than replaying a write.
- A `standard` flow stays lightweight. Declared external actions, multi-agent/multi-host work, releases, production work, or regulated work auto-escalate to `strict`; strict cannot be silently downgraded.
- Each flow pins `policy_id`, version and digest. A different policy requires `checkpoint_flow` with the explicit `migrate-policy` confirmation.
- Only the controller-owned state block is compared for drift. Normal Plan Tree prose can change safely; malformed or changed controlled state freezes the flow rather than being overwritten.
- Evidence artifacts must remain inside `plan_root`, must exist, and must match their SHA-256 digest. Agent claims, native host-plan status and phase completion never substitute for evidence.
- A native host plan or goal is an advisory session aid. Its absence does not block delivery or closure.
- Every controlled external effect requires an exact, short-lived, single-use authorization bound to action, target, environment and request digest. It does not grant the effect itself.
- `close_or_cancel_flow` is the only completion path. If it returns `unmet_criteria`, preserve the non-terminal state and report the smallest remaining gate.

Do not hand-edit the controlled state block. Do not treat hooks as a security sandbox. If the controller is unavailable, preserve a Plan Tree handoff and do not claim a verified completion.
