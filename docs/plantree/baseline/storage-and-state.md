# Storage And State

- Plan Tree is the durable business authority.
- `workflow-policy.json` is the versioned machine-checkable source for structural workflow rules. Generated runtime values are derived from it and are not a second authority.
- Each controller flow pins the selected policy identity, version and canonical digest. Policy changes require an explicit compatible migration; a policy mismatch cannot silently reinterpret an in-flight flow.
- SQLite/WAL is rebuildable control state for revisions, journals, strict-mode leases, evidence indexes, authorizations and metrics.
- The controller hashes only its controlled state block. Plan Tree prose and rationale can evolve without becoming accidental controller drift; an out-of-band controlled-block change is frozen for reconciliation.
- Evidence artifact paths are restricted to policy-approved roots under the active Plan Tree target. Secrets and sensitive payloads are not stored in policy state, evidence, authorization records or metrics.
- The plugin bundle is generated from source and contains no runtime database.
- Plugin upgrades preserve `~/.codex/state/delivery-control/delivery-control.sqlite`.
- Recovery backups are bounded and excluded from Git.
