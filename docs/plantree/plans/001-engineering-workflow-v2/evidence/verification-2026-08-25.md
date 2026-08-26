# Engineering Workflow 2.0 Verification

## Acceptance Coverage

| Acceptance | Evidence |
| --- | --- |
| AC-01 | Class tests cover generation initialization, fixed-point updates, scope revision and stale generation rejection. |
| AC-02 | Close-gate test proves consumed authorization alone fails, failed action result blocks and a matching superseding success passes. |
| AC-03 | Bundled stdio MCP test proves low-level commit operations are absent and constrained high-level operations are present. |
| AC-04 | Route-template tests prove `phase_sequence` and `next_phase` are controller-derived. |
| AC-05 | Digest primitives, Plan Tree file projection, database schema, route policy and state model live in focused `src/lib/` modules behind `DeliveryControl`. |
| AC-06 | `npm run generate:check` proves runtime policy, schemas and workflow reference artifacts match the canonical plugin policy. |
| AC-07 | Independent process contention, hard process exit recovery, portable path tests, CLI plugin discovery and cached stdio handshake passed. |

## Verification Receipts

- `npm run check`: 40 tests passed after build, canonical-policy drift check and MCP input-schema assertions.
- `test-state.ps1`: all state transition cases passed under Windows PowerShell 5 and PowerShell 7.
- `test-upgrades.ps1`: all compatibility wrapper cases passed under Windows PowerShell 5 and PowerShell 7.
- `test-validate.ps1`: baseline plus 14 fault-injection cases passed.
- `validate.ps1`: Windows PowerShell 5 and PowerShell 7 each checked 28 Ask Matt Skills; Plan Tree 0.4.0 and Product Design 0.1.47 were accepted; optional PyYAML warning only.
- Installed plugin: `delivery-control@personal` version `2.0.0+codex.20260825065211`, enabled.
- Installed cached bundle: stdio MCP handshake and exact 21-tool surface/schema test passed.
- Repository, global Skill/plugin source and cached bundle hashes matched. The final bundle SHA-256 is `1970C71AA580BA2E582D69B63B9A19EF6105D0A243A738D27B1434EF5C58CC15`.
- Persistent database: `~/.codex/state/delivery-control/delivery-control.sqlite` remained in place with its prior size and timestamp.

## Authority Receipt

Local implementation, build, test, Skill sync and plugin reinstall were performed. No commit, push, PR, merge, deploy, tracker write, production action, credential access or external message was performed.
