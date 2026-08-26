# Decision 001 - Generation And Policy Authority

## Decision

Every close-gate artifact belongs to one delivery generation and fixed point. A scope change starts a new generation rather than selectively guessing which old evidence remains valid.

The canonical route and state policy lives in one JSON source under the Delivery Control plugin. Runtime constants, JSON schemas and the Engineering Workflow reference contract are generated artifacts.

## Consequences

- Old evidence remains auditable but cannot satisfy current acceptance criteria.
- A scope change requires new spec/implementation/Review evidence as the selected route requires.
- Installed artifacts do not need the generator at runtime.
- Drift is a build/validation failure rather than a manual synchronization task.
