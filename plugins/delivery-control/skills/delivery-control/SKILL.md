---
name: delivery-control
description: Audit, recover, authorize, diagnose, synchronize, close, or cancel a transaction-controlled engineering delivery flow. Use manually for workflow status and metrics, or automatically when engineering-workflow detects Plan Tree drift, a crash journal, stale native Plan projection, authorization failure, recovery need, or completion-gate failure. Do not use as the normal feature-delivery router.
---

# Delivery Control

Operate the local `delivery-control` MCP server. Plan Tree is the durable business authority; SQLite is a rebuildable transaction journal, lease store, authorization ledger, evidence index, and aggregate metrics cache.

## Inspect First

Call `inspect_flow`, then `audit_consistency`, before mutation. On a new task, crash, or uncertain handoff, call `recover_flow` with the last known revision and request digest. Supply `plan_root` and `plan_target` only when rebuilding a missing controller record from Plan Tree.

Every write call requires the current `flow_id`, `expected_revision`, and a SHA-256 digest of the exact normalized request. A revision conflict means another writer won; inspect again and do not retry stale content. A frozen flow requires a drift report and user-owned resolution before any further write.

## Diagnose And Recover

- `prepared` with the original Plan Tree digest rolls back.
- A projected digest completes the interrupted database commit.
- An unrelated digest freezes the flow as `awaiting-user`; report both expected digests and the actual digest.
- Missing SQLite state rebuilds from exactly one valid Plan Tree state block.
- Plan Tree wins any authority conflict, but drift is never silently accepted or overwritten.

Do not hand-edit the controlled state block. Do not use the legacy PowerShell bridge to write state.

## Authorization

Use `request_authorization` only for commit, push, pull request, merge, deploy, tracker write, production data, credential access, external message, or costly real-service calls. Authorization binds action, target, environment, request digest, expiry, and nonce.

When structured elicitation succeeds, the server confirms the request. Otherwise show the returned challenge code to the user and call `confirm_authorization` only after the user returns that exact code in a later message. Call `consume_authorization` immediately before the exact action. A changed request, expired receipt, scope mismatch, or replay fails closed. Codex action-time permission checks still apply.

## Native Plan And Completion

Use `project_native_plan`, apply its exact steps through Codex `update_plan`, then call `confirm_native_plan` with the applied steps. When `update_plan` is unavailable, record `available: false` and a concrete handoff; never claim synchronization.

Record evidence through `validate_evidence`. Each item must bind one or more acceptance IDs and a real artifact digest. Use `close_flow` only after terminal observation. If it returns `unmet_criteria`, preserve the non-terminal state and report only the smallest remaining gate.

Use `get_metrics` for redacted aggregate counts. Use `cancel_flow` only for an explicit user cancellation; it preserves all recovery state.
