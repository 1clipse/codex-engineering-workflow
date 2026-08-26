# Storage And State

- Plan Tree is the durable business authority.
- SQLite/WAL is rebuildable control state for revisions, journals, leases, evidence indexes, authorizations and metrics.
- The plugin bundle is generated from source and contains no runtime database.
- Plugin upgrades preserve `~/.codex/state/delivery-control/delivery-control.sqlite`.
- Recovery backups are bounded and excluded from Git.
