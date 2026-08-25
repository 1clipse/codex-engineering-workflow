import { readFileSync } from "node:fs";

const POLICY = JSON.parse(readFileSync(new URL("../schemas/workflow-policy.json", import.meta.url), "utf8"));

export const FLOW_VALUES = POLICY.flows;
export const STATUS_VALUES = POLICY.statuses;
export const PHASE_VALUES = POLICY.phases;
export const EVIDENCE_RESULTS = ["passed", "verified", "accepted", "observed"];
export const STATE_START = "<!-- delivery-control:state:start -->";
export const STATE_END = "<!-- delivery-control:state:end -->";
export const LEGACY_START = "<!-- engineering-workflow:state:start -->";
export const LEGACY_END = "<!-- engineering-workflow:state:end -->";
export const SCHEMA_VERSION = 2;
export const DEFAULT_BACKUP_RETENTION = 5;
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

export const PHASE_TRANSITIONS = POLICY.allowed_phase_transitions;
export const STATUS_TRANSITIONS = POLICY.allowed_status_transitions;
export const EVENT_RULES = POLICY.event_rules;
export const PHASE_ORDER = POLICY.phase_order;
export const REQUIRED_PHASES_BY_FLOW = POLICY.required_phases_by_flow;
export const REQUIRED_PHASE_SKIP_EXCEPTIONS = POLICY.required_phase_skip_exceptions || {};
