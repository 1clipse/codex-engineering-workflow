export const FLOW_VALUES = ["main", "bug", "triage", "wayfinder", "maintenance", "direct"];
export const STATUS_VALUES = ["active", "awaiting-user", "blocked-external", "partial", "failed", "complete", "cancelled"];
export const PHASE_VALUES = ["route", "setup", "clarify", "prototype", "spec", "tickets", "goal", "execute", "review", "close"];
export const EVIDENCE_RESULTS = ["passed", "verified", "accepted", "observed"];
export const STATE_START = "<!-- delivery-control:state:start -->";
export const STATE_END = "<!-- delivery-control:state:end -->";
export const LEGACY_START = "<!-- engineering-workflow:state:start -->";
export const LEGACY_END = "<!-- engineering-workflow:state:end -->";
export const SCHEMA_VERSION = 1;
export const DEFAULT_LEASE_MS = 30_000;
export const DEFAULT_AUTH_TTL_MS = 5 * 60_000;

export const PHASE_LABELS = {
  route: "Inspect context and choose the delivery route",
  setup: "Prepare route-required local configuration",
  clarify: "Resolve the smallest user-owned uncertainty",
  prototype: "Produce runnable evidence for an open question",
  spec: "Lock scope, approach, acceptance, verification, dependencies, and risks",
  tickets: "Split durable work into explicit frontier tickets",
  goal: "Compile the selected frontier into a verifiable goal",
  execute: "Implement the approved contract and capture evidence",
  review: "Review against the recorded fixed point and resolve findings",
  close: "Verify the terminal condition and report final state"
};

export const SENSITIVE_ACTIONS = new Set([
  "commit", "push", "pull-request", "merge", "deploy", "tracker-write",
  "production-data", "credential-access", "external-message", "costly-service-call"
]);

export const PHASE_TRANSITIONS = {
  route: ["route", "setup", "clarify", "prototype", "spec", "tickets", "goal", "execute", "review", "close"],
  setup: ["route", "setup", "clarify", "prototype", "spec", "tickets", "goal", "execute", "review"],
  clarify: ["route", "clarify", "prototype", "spec", "tickets", "goal", "execute"],
  prototype: ["route", "clarify", "prototype", "spec", "tickets", "goal", "execute", "review", "close"],
  spec: ["route", "clarify", "prototype", "spec", "tickets", "goal", "execute"],
  tickets: ["route", "clarify", "spec", "tickets", "goal", "execute"],
  goal: ["route", "clarify", "spec", "tickets", "goal", "execute"],
  execute: ["route", "clarify", "prototype", "spec", "tickets", "goal", "execute", "review"],
  review: ["route", "execute", "review", "close"], close: ["close"]
};

export const STATUS_TRANSITIONS = {
  active: ["active", "awaiting-user", "blocked-external", "partial", "failed", "complete", "cancelled"],
  "awaiting-user": ["active", "awaiting-user", "blocked-external", "partial", "failed", "cancelled"],
  "blocked-external": ["active", "awaiting-user", "blocked-external", "partial", "failed", "cancelled"],
  partial: ["active", "awaiting-user", "blocked-external", "partial", "failed", "cancelled"],
  failed: ["active", "failed", "cancelled"], complete: ["complete"], cancelled: ["active", "cancelled"]
};

export const EVENT_RULES = {
  "route-selected": { status: ["active"], current_phase: ["route"] },
  "spec-not-ready": { status: ["active"], current_phase: ["clarify", "spec"] },
  "several-frontiers": { status: ["awaiting-user"], current_phase: ["tickets"] },
  "user-decision-needed": { status: ["awaiting-user"] }, "external-blocker": { status: ["blocked-external"] },
  "partial-result": { status: ["partial"] }, "execution-blocked": { status: ["awaiting-user"], current_phase: ["execute"] },
  "unrecoverable-failure": { status: ["failed"], next_phase: ["none"] },
  "review-p0-p1": { status: ["active"], current_phase: ["execute"], next_phase: ["review"] },
  "scope-change": { status: ["active"], current_phase: ["route"] },
  "user-cancelled": { status: ["cancelled"], next_phase: ["none"] }, "user-resumed": { status: ["active"] },
  "terminal-verified": { status: ["complete"], current_phase: ["close"], next_phase: ["none"] }
};
