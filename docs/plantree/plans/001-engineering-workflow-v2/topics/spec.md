# Engineering Workflow 2.0 Specification

## Problem Statement

The 1.x workflow verifies artifacts and authorization but does not bind them to a scope generation, does not prove that authorized external effects succeeded, and still exposes low-level mutation primitives. Its policy is copied across runtimes, the controller is concentrated in one large module, and recovery tests do not exercise independent processes or the installed Codex host.

## Solution

Introduce a delivery generation and fixed point, bind all close-gate material to it, record external-action outcomes, make route templates drive progression through constrained operations, split controller responsibilities and generate all policy assets from one canonical JSON file. Verify the resulting plugin through class, stdio MCP, independent process and Codex installation seams.

## Implementation Decisions

- A scope change increments `delivery_generation`, records a new `scope_digest`, clears the active fixed point and leaves prior evidence as historical but ineligible.
- The fixed point records current spec, implementation and Review digests. Evidence and Review records bind to the current generation and subject digest.
- Authorization continues to be single-use and exact-scope. A separate action-result record proves success or failure after execution.
- Route templates declare required and optional phase sequences. The controller derives `next_phase`; high-level callers report outcomes instead of patches.
- Low-level transition methods may remain internal for recovery and tests but are removed from the normal MCP surface.
- The canonical policy lives with Delivery Control source. A generator emits runtime policy code, schemas and the workflow reference copy.
- Public behavior remains testable through `DeliveryControl` and bundled stdio MCP; internal module layout is not a compatibility surface.

## Testing Decisions

- Keep behavior tests at the class seam and MCP contract tests at stdio.
- Add independent child-process writer contention and crash recovery tests.
- Exercise relative artifact paths in directories containing spaces and non-ASCII characters.
- Validate generated files are current by running the generator in check mode.
- Reinstall with a cachebuster and verify Codex CLI reports the plugin enabled from the updated cache; directly handshake with that cached bundle.

## External Authority

Local file edits, builds, tests and plugin reinstall are authorized by this request. Commit, push, PR, merge, deploy, tracker mutation, production data access, credentials and unrelated external communication remain ungranted.

SPEC READY

- Status: ready for implementation
- Source: `docs/plantree/plans/001-engineering-workflow-v2/topics/spec.md`
- Repository: `codex-engineering-workflow`
- Baseline: `51104cf` on `main`
- Test seam: `DeliveryControl` public class and bundled stdio MCP
- Non-goals: external action execution, upstream package changes, network services
- External authority: local implementation/build/test/reinstall only; commit/push/release ungranted
- Next route: tracer-bullet implementation tickets
