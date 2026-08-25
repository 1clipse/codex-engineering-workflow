---
name: delivery-control
description: Audit, recover, authorize, diagnose, synchronize, close, or cancel a transaction-controlled engineering delivery flow. Use manually for workflow status and metrics, or automatically when engineering-workflow detects Plan Tree drift, a crash journal, stale native Plan projection, authorization failure, recovery need, or completion-gate failure. Do not use as the normal feature-delivery router.
---

# Delivery Control

Operate the local `delivery-control` MCP server. Plan Tree is the durable business authority; SQLite is a rebuildable transaction journal, lease store, authorization ledger, evidence index, and aggregate metrics cache.

## Inspect First

Call `inspect_flow`, then `audit_consistency`, before mutation. On a new task, crash, or uncertain handoff, call `recover_flow` with the last known revision and request digest. Supply `plan_root` and `plan_target` only when rebuilding a missing controller record from Plan Tree.

Every write call requires the current `flow_id`, `expected_revision`, and a SHA-256 digest of the exact normalized request. A revision conflict means another writer won; inspect again and do not retry stale content. A frozen flow requires a drift report and user-owned resolution before any further write.

The external action digest in an authorization is separate from the controller mutation digest used to journal the authorization request, confirmation, and consumption. Receipts retain both digests. Required phases cannot be skipped; a previous completed phase remains valid after a scope-change rework loop.

For ordinary progression prefer `start_or_resume_flow`, `advance_flow`, `record_delivery_evidence`, `record_review_findings`, and `close_verified_flow`. The lower-level transition tools remain available for recovery and diagnostics.

After the user confirms that the original Plan Tree was restored, call `resolve_drift` with `resolution: "accept-restored-plan-tree"` and a concrete reason. The tool clears the frozen marker only when the file digest equals the controller digest, no pending journal transaction remains, and the restored state block matches the controller revision.

## Diagnose And Recover

- `prepared` with the original Plan Tree digest rolls back.
- A projected digest completes the interrupted database commit.
- An unrelated digest freezes the flow as `awaiting-user`; report both expected digests and the actual digest.
- Missing SQLite state rebuilds from exactly one valid Plan Tree state block.
- Plan Tree wins any authority conflict, but drift is never silently accepted or overwritten.

Do not hand-edit the controlled state block. Do not use the legacy PowerShell bridge to write state.

## Authorization

Use `request_authorization` only for commit, push, pull request, merge, deploy, tracker write, production data, credential access, external message, or costly real-service calls. Authorization binds action, target, environment, the exact external-action digest, a separate controller mutation digest, expiry, and nonce.

When structured elicitation succeeds, the server confirms the request. Otherwise show the returned challenge code to the user and call `confirm_authorization` only after the user returns that exact code in a later message. Call `consume_authorization` immediately before the exact action. A changed request, expired receipt, scope mismatch, or replay fails closed. Codex action-time permission checks still apply.

## Native Plan And Completion

Use `project_native_plan`, apply its exact steps through Codex `update_plan`, then call `confirm_native_plan` with the applied steps. When `update_plan` is unavailable, record `available: false` and a concrete handoff; never claim synchronization.

Record evidence through `record_delivery_evidence` or `validate_evidence`. Each item must bind one or more acceptance IDs and a real artifact digest. Review findings must have an explicit disposition, cannot be silently deleted, and fixed P0/P1 findings require a re-verifier. Use `close_verified_flow` only after a terminal observation references a current valid evidence record with the same artifact and digest. If it returns `unmet_criteria`, preserve the non-terminal state and report only the smallest remaining gate.

External action declarations include `request_digest`; completion accepts a receipt only when action, target, environment, and request digest all match exactly. Relative artifacts are resolved against the flow's `plan_root` before they are stored or checked.

Use `get_metrics` for redacted aggregate counts. Use `cancel_flow` only for an explicit user cancellation; it preserves all recovery state.
