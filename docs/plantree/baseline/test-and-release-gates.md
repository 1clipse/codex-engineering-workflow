# Test And Release Gates

- Unit and behavior tests exercise the public `DeliveryControl` interface.
- stdio MCP tests exercise the bundled public tool surface.
- PowerShell 5/7 tests validate workflow contracts and dependency failures.
- Cross-process tests must cover writer contention and injected process termination.
- Host smoke tests must prove Codex sees the installed plugin and its cached MCP bundle.
- `git diff --check`, manifest validation, generated-asset drift and secret scans gate publication.
