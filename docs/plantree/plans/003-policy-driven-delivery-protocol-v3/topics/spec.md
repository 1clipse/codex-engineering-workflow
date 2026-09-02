# Policy-Driven Delivery Protocol 3.0 Specification

## Authority Model

The durable layers have separate roles:

1. User intent and repository instructions authorize work.
2. Plan Tree stores business scope, decisions, specifications, and human-readable evidence references.
3. `workflow-policy.json` defines machine-checkable routes, profiles, state transitions, action classes, evidence constraints, and host capabilities.
4. Generated runtime values and schemas may be derived from that JSON, but must not become a second editable policy authority.
5. Delivery Control validates and persists a rebuildable flow projection; it does not become an independent business authority.
6. Thin host instructions load the policy, request semantic clarification when needed, and route work. They do not restate the full protocol in prompt text.
7. Codex `/plan` and `/goal` are session-local runtime facilities. Their presence, absence, or text must not determine delivery completion.

## Policy and Migration

`workflow-policy.json` declares `policy_id`, semantic `schema_version`, a calculated canonical digest, and two modes:

- `standard`: default for ordinary scoped engineering. It records state, relevant evidence, and close checks without requiring a multi-writer lease, fixed-point checkpoint, or host-plan attestation.
- `strict`: selected for multi-Agent, multi-host, release, production, regulated, or declared external-action work. It adds lease, fixed-point, enhanced recovery/audit, and exact authorization requirements.

Every new flow stores the selected mode plus the policy identity, version, and digest. A request that signals strict work must escalate to `strict`; an in-flight strict flow cannot silently downgrade. Existing flows are treated as legacy until explicitly migrated; a policy digest mismatch freezes only the controlled state until the caller provides an explicit compatible migration path. Controlled external actions always require exact, single-use authorization and cannot be justified by a host plan, a Hook, or a label.

## State and Evidence

The controller computes a digest from the parsed controlled JSON state block, not the complete Markdown target. Editing Plan Tree prose outside that block is valid and must not freeze the flow. Editing the controlled block outside the controller is drift. Scope changes update Plan Tree's business rationale before the controller establishes a new controlled-state checkpoint.

Evidence artifacts resolve inside `plan_root` by default. Absolute paths are accepted only after resolution proves they remain under that root; escape attempts fail closed. A later policy may introduce explicit named artifact roots, but an arbitrary host filesystem path is never an evidence root.

## Host Integration

Host-plan projection is optional. Codex may project a current phase into native Plan/Goal and Hooks may supply recovery, compact-checkpoint, or close-preflight context. Hook configuration is opt-in and must have a manual command/handoff fallback. Hosts without an equivalent receive a concrete handoff. Delivery closure depends on the policy's evidence, review, authorization, and terminal-observation gates—not native plan synchronization.

## Public Control Surface

Normal routes use only high-level lifecycle verbs: start/resume, route, checkpoint, record evidence, authorize one external action, audit/recover, and close/cancel. Read-only inspection may be exposed as diagnostics, but normal clients must not need transaction, journal, lease, or CAS primitives. Legacy granular method names may remain internal only while adapters migrate.

## Verification

Test policy generation and runtime pinning, standard versus strict behavior, intentional policy migration, ordinary Markdown edits versus controlled-block edits, artifact-root and symlink escapes, unavailable host plans, valid strict close, recovery after a projected write, Hook fallback without a Hook installation, and the declared public MCP tool surface.
