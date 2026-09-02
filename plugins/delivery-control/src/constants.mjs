import { POLICY, POLICY_DIGEST } from "./policy.generated.mjs";

export { POLICY, POLICY_DIGEST };
export const FLOW_VALUES = POLICY.flows;
export const STATUS_VALUES = POLICY.statuses;
export const PHASE_VALUES = POLICY.phases;
export const MODE_VALUES = Object.keys(POLICY.modes.profiles);
export const DEFAULT_MODE = POLICY.modes.default;
export const STRICT_ESCALATION_SIGNALS = POLICY.modes.strict_escalation_signals;
export const MODE_PROFILES = POLICY.modes.profiles;
export const EVIDENCE_RESULTS = POLICY.evidence_results;
export const REVIEW_SEVERITIES = POLICY.review.severities;
export const REVIEW_DISPOSITIONS = POLICY.review.dispositions;
export const FIXED_POINT_PHASES = POLICY.review.fixed_point_phases;
export const CONTROLLED_ARTIFACT_ROOTS = POLICY.delivery_protocol.artifact_roots;
export const CLOSE_GATES = POLICY.delivery_protocol.close_gates;
export const STATE_START = "<!-- delivery-control:state:start -->";
export const STATE_END = "<!-- delivery-control:state:end -->";
export const LEGACY_START = "<!-- engineering-workflow:state:start -->";
export const LEGACY_END = "<!-- engineering-workflow:state:end -->";
export const SCHEMA_VERSION = 6;
export const DEFAULT_BACKUP_RETENTION = 5;
export const DEFAULT_LEASE_MS = 30_000;
export const DEFAULT_AUTH_TTL_MS = 5 * 60_000;

export const PHASE_LABELS = POLICY.phase_labels;

export const SENSITIVE_ACTIONS = new Set(POLICY.delivery_protocol.external_actions);

export const PHASE_TRANSITIONS = POLICY.allowed_phase_transitions;
export const STATUS_TRANSITIONS = POLICY.allowed_status_transitions;
export const EVENT_RULES = POLICY.event_rules;
export const PHASE_ORDER = POLICY.phase_order;
export const REQUIRED_PHASES_BY_FLOW = POLICY.required_phases_by_flow;
export const REQUIRED_PHASE_SKIP_EXCEPTIONS = POLICY.required_phase_skip_exceptions || {};
export const ROUTE_TEMPLATES = POLICY.route_templates;
