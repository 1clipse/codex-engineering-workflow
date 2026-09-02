# Test And Release Gates

- Unit and behavior tests exercise the public `DeliveryControl` interface, policy pinning/migration, standard versus strict profiles, and fail-closed authorization.
- Generator checks prove that runtime constants and schemas are derived from canonical JSON without drift.
- stdio MCP tests exercise the bundled high-level public tool surface without exposing transaction primitives as normal operations.
- PowerShell 5/7 tests validate workflow contracts and dependency failures.
- Cross-process tests must cover strict-mode writer contention and injected process termination; recovery must preserve or explicitly freeze state rather than silently lose it.
- Drift and evidence tests must distinguish legitimate Plan Tree prose edits from controlled-state edits and reject artifact-root escapes.
- Host smoke tests must prove supported hosts see their installed adapter and bundled MCP server. Missing native Plan/Goal or Hook support must take the documented fallback path.
- `git diff --check`, manifest validation, generated-asset drift and secret scans gate publication.
