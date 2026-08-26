import { randomUUID } from "node:crypto";
import {
  EVENT_RULES, FLOW_VALUES, LEGACY_END, LEGACY_START, PHASE_ORDER, PHASE_TRANSITIONS,
  PHASE_VALUES, REQUIRED_PHASES_BY_FLOW, REQUIRED_PHASE_SKIP_EXCEPTIONS, STATE_END,
  STATE_START, STATUS_TRANSITIONS, STATUS_VALUES
} from "../constants.mjs";
import { assertString, canonical, sha256 } from "./primitives.mjs";
import { routeSequence, skippedPhases } from "./route-policy.mjs";

export function normalizeState(input) {
  const deliveryGeneration = input.delivery_generation ?? 1;
  const scopeDigest = input.scope_digest ?? sha256(canonical({
    acceptance_criteria: input.acceptance_criteria || [],
    terminal_condition: input.terminal_condition || "legacy-unverified"
  }));
  const fixedPoint = input.fixed_point ?? {};
  const state = {
    flow_id: assertString(input.flow_id, "flow_id"),
    revision: Number(input.revision),
    flow: assertString(input.flow, "flow"),
    status: assertString(input.status, "status"),
    current_phase: assertString(input.current_phase, "current_phase"),
    next_phase: assertString(input.next_phase, "next_phase"),
    plan_target: assertString(input.plan_target, "plan_target"),
    terminal_condition: assertString(input.terminal_condition, "terminal_condition"),
    resume_point: assertString(input.resume_point, "resume_point"),
    delivery_generation: Number(deliveryGeneration),
    scope_digest: scopeDigest,
    fixed_point: {
      generation: Number(fixedPoint.generation ?? deliveryGeneration),
      spec_digest: fixedPoint.spec_digest ?? null,
      implementation_digest: fixedPoint.implementation_digest ?? null,
      review_digest: fixedPoint.review_digest ?? null
    },
    route: input.route ?? null,
    acceptance_criteria: Array.isArray(input.acceptance_criteria) ? input.acceptance_criteria : [],
    required_evidence_types: Array.isArray(input.required_evidence_types) ? input.required_evidence_types : [],
    external_actions: Array.isArray(input.external_actions) ? input.external_actions : [],
    external_action_results: Array.isArray(input.external_action_results) ? input.external_action_results : [],
    plan_sync: input.plan_sync ?? "pending",
    native_plan_digest: input.native_plan_digest ?? null,
    correlation_id: input.correlation_id ?? null,
    receipt_digest: input.receipt_digest ?? null,
    terminal_observation: input.terminal_observation ?? null,
    review_findings: Array.isArray(input.review_findings) ? input.review_findings : [],
    evidence_records: Array.isArray(input.evidence_records) ? input.evidence_records : [],
    authorization_receipts: Array.isArray(input.authorization_receipts) ? input.authorization_receipts : [],
    history: Array.isArray(input.history) ? input.history : []
  };
  if (!Number.isInteger(state.revision) || state.revision < 0) throw new Error("revision must be a non-negative integer");
  if (!Number.isInteger(state.delivery_generation) || state.delivery_generation < 1) throw new Error("delivery_generation must be a positive integer");
  if (state.fixed_point.generation !== state.delivery_generation) throw new Error("fixed_point generation must match delivery_generation");
  for (const [name, digest] of [["scope_digest", state.scope_digest], ...Object.entries(state.fixed_point).filter(([name]) => name !== "generation")]) {
    if (digest !== null && !/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`${name} must be sha256:<64 lowercase hex>`);
  }
  if (!FLOW_VALUES.includes(state.flow)) throw new Error(`unknown flow: ${state.flow}`);
  if (!STATUS_VALUES.includes(state.status)) throw new Error(`unknown status: ${state.status}`);
  if (!PHASE_VALUES.includes(state.current_phase)) throw new Error(`unknown current_phase: ${state.current_phase}`);
  if (state.next_phase !== "none" && !PHASE_VALUES.includes(state.next_phase)) throw new Error(`unknown next_phase: ${state.next_phase}`);
  if (state.route) {
    const approvedSpec = state.route.approved_spec === true;
    const setupRequired = state.route.setup_required === true || (state.route.setup_required === undefined && Array.isArray(state.route.skipped_phases) && !state.route.skipped_phases.includes("setup"));
    const expectedSequence = routeSequence(state.flow, { setupRequired, approvedSpec });
    if (state.route.phase_sequence && canonical(state.route.phase_sequence) !== canonical(expectedSequence)) throw new Error("route phase_sequence does not match the controller template");
    state.route = {
      ...state.route,
      template: state.flow,
      setup_required: setupRequired,
      approved_spec: approvedSpec,
      phase_sequence: expectedSequence,
      skipped_phases: skippedPhases(expectedSequence)
    };
  }
  const ids = new Set();
  state.acceptance_criteria = state.acceptance_criteria.map((criterion) => {
    const acceptance_id = assertString(criterion.acceptance_id, "acceptance_id");
    if (ids.has(acceptance_id)) throw new Error(`duplicate acceptance_id: ${acceptance_id}`);
    ids.add(acceptance_id);
    return { acceptance_id, description: assertString(criterion.description, "acceptance description") };
  });
  const findingIds = new Set();
  state.review_findings = state.review_findings.map((finding) => {
    const finding_id = assertString(finding.finding_id, "finding_id");
    if (findingIds.has(finding_id)) throw new Error(`duplicate finding_id: ${finding_id}`);
    findingIds.add(finding_id);
    const severity = assertString(finding.severity, "finding severity");
    const disposition = assertString(finding.disposition, "finding disposition");
    if (!["P0", "P1", "P2", "P3"].includes(severity)) throw new Error(`unknown finding severity: ${severity}`);
    if (!["open", "fixed", "accepted", "deferred"].includes(disposition)) throw new Error(`unknown finding disposition: ${disposition}`);
    if (["fixed", "accepted", "deferred"].includes(disposition) && !assertString(finding.reason || finding.reverified_by || "", "finding disposition reason")) throw new Error(`finding ${finding_id} needs a disposition reason`);
    const delivery_generation = Number(finding.delivery_generation ?? state.delivery_generation);
    if (!Number.isInteger(delivery_generation) || delivery_generation < 1) throw new Error("finding delivery_generation must be a positive integer");
    const fixed_point_digest = finding.fixed_point_digest ?? state.fixed_point.implementation_digest ?? state.fixed_point.spec_digest ?? state.scope_digest;
    if (!/^sha256:[0-9a-f]{64}$/.test(fixed_point_digest)) throw new Error("finding fixed_point_digest must be sha256:<64 lowercase hex>");
    return { finding_id, severity, disposition, reason: finding.reason || null, reverified_by: finding.reverified_by || null, delivery_generation, fixed_point_digest, review_run_id: finding.review_run_id || null };
  });
  const actionIds = new Set();
  state.external_actions = state.external_actions.map((action) => {
    const normalized = { action: assertString(action.action, "external action"), target: assertString(action.target, "external target"), environment: assertString(action.environment, "external environment"), request_digest: action.request_digest || null };
    const key = `${normalized.action}|${normalized.target}|${normalized.environment}|${normalized.request_digest || "legacy"}`;
    if (actionIds.has(key)) throw new Error(`duplicate external action: ${key}`);
    actionIds.add(key);
    if (normalized.request_digest && !/^sha256:[0-9a-f]{64}$/.test(normalized.request_digest)) throw new Error("external action request_digest must be sha256:<64 lowercase hex>");
    return normalized;
  });
  const resultIds = new Set();
  state.external_action_results = state.external_action_results.map((result) => {
    const legacyUnverified = result.legacy_unverified === true || !result.artifact || !result.artifact_digest || !result.command_or_request_id;
    const normalized = {
      action_result_id: assertString(result.action_result_id, "action_result_id"),
      authorization_id: assertString(result.authorization_id, "authorization_id"),
      action: assertString(result.action, "action result action"), target: assertString(result.target, "action result target"),
      environment: assertString(result.environment, "action result environment"), action_request_digest: assertString(result.action_request_digest, "action_request_digest"),
      outcome: assertString(result.outcome, "action result outcome"), observed_at: assertString(result.observed_at, "action result observed_at"),
      producer: assertString(result.producer, "action result producer"), result_digest: assertString(result.result_digest, "action result result_digest"),
      artifact: result.artifact ? assertString(result.artifact, "action result artifact") : null,
      artifact_digest: result.artifact_digest || null,
      command_or_request_id: result.command_or_request_id ? assertString(result.command_or_request_id, "action result command_or_request_id") : null,
      legacy_unverified: legacyUnverified,
      supersedes: result.supersedes || null, delivery_generation: Number(result.delivery_generation ?? state.delivery_generation)
    };
    if (resultIds.has(normalized.action_result_id)) throw new Error(`duplicate action_result_id: ${normalized.action_result_id}`);
    resultIds.add(normalized.action_result_id);
    if (!["succeeded", "failed"].includes(normalized.outcome)) throw new Error(`invalid action result outcome: ${normalized.outcome}`);
    if (Number.isNaN(Date.parse(normalized.observed_at))) throw new Error("action result observed_at must be ISO-8601");
    for (const digest of [normalized.action_request_digest, normalized.result_digest, normalized.artifact_digest].filter(Boolean)) if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error("action result digests must be sha256:<64 lowercase hex>");
    if (!Number.isInteger(normalized.delivery_generation) || normalized.delivery_generation < 1) throw new Error("action result delivery_generation must be a positive integer");
    return normalized;
  });
  if (state.terminal_observation !== null) {
    for (const field of ["evidence_id", "artifact", "artifact_digest", "observed_at", "result"]) assertString(state.terminal_observation[field], `terminal observation ${field}`);
    if (!/^sha256:[0-9a-f]{64}$/.test(state.terminal_observation.artifact_digest)) throw new Error("terminal observation artifact_digest must be sha256:<64 lowercase hex>");
  }
  return state;
}

function stateBlock(state) {
  return `${STATE_START}\n\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\`\n${STATE_END}`;
}

export function validateTransition(previous, next, event) {
  if (!PHASE_TRANSITIONS[previous.current_phase]?.includes(next.current_phase)) throw Object.assign(new Error(`illegal phase transition: ${previous.current_phase} -> ${next.current_phase}`), { code: "illegal_phase_transition" });
  if (!STATUS_TRANSITIONS[previous.status]?.includes(next.status)) throw Object.assign(new Error(`illegal status transition: ${previous.status} -> ${next.status}`), { code: "illegal_status_transition" });
  const rule = EVENT_RULES[event];
  if (rule) for (const [field, allowed] of Object.entries(rule)) if (!allowed.includes(next[field])) throw Object.assign(new Error(`${event} requires ${field} in ${allowed.join(", ")}`), { code: "event_rule_violation" });
  if (next.status === "complete" && event !== "terminal-verified") throw Object.assign(new Error("complete requires terminal-verified"), { code: "completion_gate_required" });
  if (next.current_phase === "close" && next.status !== "complete") throw Object.assign(new Error("close phase requires complete status"), { code: "invalid_close_state" });
  if (!["complete", "failed", "cancelled"].includes(next.status) && next.next_phase === "none") throw Object.assign(new Error("non-terminal state requires a next phase"), { code: "missing_next_phase" });
  const route = next.route || previous.route;
  const previousIndex = PHASE_ORDER.indexOf(previous.current_phase);
  const nextIndex = PHASE_ORDER.indexOf(next.current_phase);
  const completed = new Set([previous.current_phase, ...(previous.history || []).map((item) => item.new_phase)]);
  if (nextIndex > previousIndex && route) {
    const skipped = new Set(route.skipped_phases || []);
    for (const phase of PHASE_ORDER.slice(previousIndex + 1, nextIndex)) {
      if (!skipped.has(phase) && !completed.has(phase)) throw Object.assign(new Error(`phase ${phase} must be completed or explicitly skipped before ${next.current_phase}`), { code: "phase_skip_not_declared" });
    }
  }
  const required = REQUIRED_PHASES_BY_FLOW[next.flow] || [];
  if (next.current_phase === "execute" && required.includes("spec") && !completed.has("spec") && !next.route?.approved_spec) throw Object.assign(new Error("spec must be ready before execute"), { code: "spec_required" });
  if (next.current_phase === "review" && required.includes("execute") && !completed.has("execute")) throw Object.assign(new Error("execute must be completed before review"), { code: "execute_required" });
  if (next.current_phase === "close") {
    const skipped = new Set(next.route?.skipped_phases || previous.route?.skipped_phases || []);
    for (const phase of required) {
      const exceptionField = REQUIRED_PHASE_SKIP_EXCEPTIONS[phase];
      const approvedSpec = exceptionField ? next.route?.[exceptionField] === true : false;
      if (skipped.has(phase) && !approvedSpec) throw Object.assign(new Error(`required phase cannot be skipped: ${phase}`), { code: "required_phase_skipped" });
      if (!completed.has(phase) && !approvedSpec) throw Object.assign(new Error(`required phase is incomplete: ${phase}`), { code: "required_phase_incomplete" });
    }
  }
  const previousFindings = new Set((previous.review_findings || []).map((finding) => finding.finding_id));
  const nextFindings = new Set((next.review_findings || []).map((finding) => finding.finding_id));
  for (const findingId of previousFindings) if (!nextFindings.has(findingId)) throw Object.assign(new Error(`review finding cannot be removed: ${findingId}`), { code: "review_finding_removed" });
}

function count(text, token) {
  return text.split(token).length - 1;
}

export function replaceStateBlock(text, state) {
  const starts = count(text, STATE_START);
  const ends = count(text, STATE_END);
  if (starts > 1 || ends > 1 || starts !== ends) throw new Error("Plan Tree has invalid delivery-control markers");
  const block = stateBlock(state);
  if (starts === 0) return `${text.trimEnd()}\n\n${block}\n`;
  const start = text.indexOf(STATE_START);
  const end = text.indexOf(STATE_END, start) + STATE_END.length;
  return `${text.slice(0, start)}${block}${text.slice(end)}`;
}

export function parseStateBlock(text) {
  const starts = count(text, STATE_START);
  const ends = count(text, STATE_END);
  if (starts !== 1 || ends !== 1) throw new Error("Plan Tree must contain exactly one delivery-control state block");
  const start = text.indexOf(STATE_START) + STATE_START.length;
  const end = text.indexOf(STATE_END, start);
  const raw = text.slice(start, end).trim().replace(/^```json\s*/i, "").replace(/\s*```$/, "");
  return normalizeState(JSON.parse(raw));
}

export function parseLegacyBlock(text, target) {
  const starts = count(text, LEGACY_START);
  const ends = count(text, LEGACY_END);
  if (starts !== 1 || ends !== 1) return null;
  const body = text.slice(text.indexOf(LEGACY_START) + LEGACY_START.length, text.indexOf(LEGACY_END)).trim();
  const pairs = Object.fromEntries(body.split(/\r?\n/).map((line) => {
    const index = line.indexOf(":");
    return index < 0 ? [line, ""] : [line.slice(0, index).trim(), line.slice(index + 1).trim()];
  }));
  return normalizeState({
    flow_id: pairs.run_id || randomUUID(), revision: 0, flow: pairs.flow || "main",
    status: pairs.status || "active", current_phase: pairs.current_phase || "route",
    next_phase: pairs.next_phase || "none", plan_target: target,
    terminal_condition: pairs.terminal_condition || "Legacy terminal condition requires revalidation",
    resume_point: pairs.resume_point || "Review imported legacy state",
    acceptance_criteria: [], required_evidence_types: [], plan_sync: "unavailable"
  });
}

export function publicFlow(row) {
  if (!row) return null;
  return {
    flow_id: row.flow_id, revision: row.revision, plan_root: row.plan_root, plan_target: row.plan_target,
    flow: row.flow, status: row.status, current_phase: row.current_phase, next_phase: row.next_phase,
    terminal_condition: row.terminal_condition, resume_point: row.resume_point,
    delivery_generation: row.delivery_generation ?? 1,
    scope_digest: row.scope_digest,
    fixed_point: JSON.parse(row.fixed_point_json || JSON.stringify({ generation: row.delivery_generation ?? 1, spec_digest: null, implementation_digest: null, review_digest: null })),
    plan_tree_digest: row.plan_tree_digest, native_plan_digest: row.native_plan_digest,
    plan_sync: row.plan_sync, frozen: Boolean(row.frozen), drift_report: row.drift_report ? JSON.parse(row.drift_report) : null,
    route: row.route_json ? JSON.parse(row.route_json) : null,
    acceptance_criteria: JSON.parse(row.acceptance_json || "[]"),
    required_evidence_types: JSON.parse(row.required_types_json || "[]"),
    external_actions: JSON.parse(row.external_actions_json || "[]"),
    external_action_results: JSON.parse(row.external_action_results_json || "[]"),
    ...JSON.parse(row.gate_json || '{"review_findings":[],"terminal_observation":null}'),
    evidence_records: JSON.parse(row.evidence_json || "[]"),
    authorization_receipts: JSON.parse(row.authorization_receipts_json || "[]"),
    history: JSON.parse(row.history_json || "[]"),
    correlation_id: row.correlation_id, receipt_digest: row.receipt_digest,
    created_at: row.created_at, updated_at: row.updated_at
  };
}

export function gateJson(state) {
  return JSON.stringify({ review_findings: state.review_findings || [], terminal_observation: state.terminal_observation || null });
}
