import { DatabaseSync } from "node:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  DEFAULT_AUTH_TTL_MS, DEFAULT_LEASE_MS, DEFAULT_MODE, EVIDENCE_RESULTS, FIXED_POINT_PHASES, MODE_PROFILES,
  MODE_VALUES, PHASE_LABELS, PHASE_ORDER, POLICY, POLICY_DIGEST, SENSITIVE_ACTIONS, STRICT_ESCALATION_SIGNALS
} from "./constants.mjs";
import { assertString, canonical, fail, nowIso, ok, requestDigest, sha256 } from "./lib/primitives.mjs";
import { artifactPath, atomicProject, contained, fileDigest, readText } from "./lib/plan-tree-files.mjs";
import { nextInRoute, routeSequence, skippedPhases } from "./lib/route-policy.mjs";
import { migrateDatabase } from "./lib/database-schema.mjs";
import { controlledStateDigest, gateJson, normalizeState, parseLegacyBlock, parseStateBlock, publicFlow, replaceStateBlock, validateTransition } from "./lib/state-model.mjs";
export { sha256 } from "./lib/primitives.mjs";
export { parseStateBlock } from "./lib/state-model.mjs";

const currentPolicy = (mode, modeReason) => ({
  mode,
  mode_reason: modeReason || (mode === DEFAULT_MODE ? "policy default" : "explicit policy mode"),
  policy_id: POLICY.policy_id,
  policy_version: POLICY.schema_version,
  policy_digest: POLICY_DIGEST
});

const isCurrentPolicy = (row) => row.policy_id === POLICY.policy_id && row.policy_version === POLICY.schema_version && row.policy_digest === POLICY_DIGEST && MODE_VALUES.includes(row.mode);

const stateBlockDigest = (text) => {
  try { return controlledStateDigest(parseStateBlock(text)); }
  catch (error) { throw Object.assign(new Error(`controlled Plan Tree state is invalid: ${error.message}`), { code: "plan_tree_drift" }); }
};

const mutationDigest = (operation, input) => input.request_digest || sha256(canonical({
  operation,
  flow_id: input.flow_id || null,
  expected_revision: input.expected_revision ?? null,
  kind: input.kind || null,
  request_summary: input.request_summary || null
}));

const externalDigest = (input) => input.external_request_digest || sha256(canonical({
  action: input.action,
  target: input.target,
  environment: input.environment,
  request_summary: input.request_summary || null
}));

function requestedMode(input) {
  const signals = new Set(input.strict_signals || []);
  if ((input.external_actions || []).length) signals.add("external-action");
  for (const signal of signals) if (!STRICT_ESCALATION_SIGNALS.includes(signal)) throw Object.assign(new Error(`unknown strict escalation signal: ${signal}`), { code: "unknown_strict_signal" });
  const requested = input.mode ?? (signals.size ? "strict" : DEFAULT_MODE);
  if (!MODE_VALUES.includes(requested)) throw Object.assign(new Error(`unknown delivery mode: ${requested}`), { code: "unknown_delivery_mode" });
  if (signals.size && requested !== "strict") throw Object.assign(new Error("strict mode is required for the declared delivery risk"), { code: "strict_mode_required", signals: [...signals] });
  return { mode: requested, mode_reason: input.mode_reason || (signals.size ? `strict escalation: ${[...signals].join(", ")}` : "policy default"), signals: [...signals] };
}

export class DeliveryControl {
  constructor(options = {}) {
    this.clock = options.clock ?? Date.now;
    this.fault = options.fault ?? (() => {});
    this.dbPath = options.dbPath ?? join(homedir(), ".codex", "state", "delivery-control", "delivery-control.sqlite");
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
  }

  close() { this.db.close(); }

  migrate() {
    migrateDatabase(this.db);
  }

  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = fn(); this.db.exec("COMMIT"); return value; }
    catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }

  row(flowId) { return this.db.prepare("SELECT * FROM flows WHERE flow_id=?").get(flowId); }

  policyStatus(row) {
    if (isCurrentPolicy(row)) return { ok: true };
    return {
      ok: false,
      error: {
        code: "policy_migration_required",
        message: "flow is pinned to a legacy or different policy; migrate it explicitly before changing delivery state",
        expected: { policy_id: POLICY.policy_id, policy_version: POLICY.schema_version, policy_digest: POLICY_DIGEST },
        actual: { policy_id: row.policy_id || "legacy-unverified", policy_version: row.policy_version || "legacy", policy_digest: row.policy_digest || null, mode: row.mode || "legacy" }
      }
    };
  }

  migratePolicy(input) {
    const row = this.row(input.flow_id);
    if (!row) return fail("flow_not_found", `unknown flow: ${input.flow_id}`);
    if (row.revision !== input.expected_revision) return fail("revision_conflict", "expected_revision is stale", { actual: row.revision });
    if (input.accept_current_policy !== true) return fail("policy_migration_confirmation_required", "explicit accept_current_policy is required");
    const targetMode = input.mode || (row.mode === "strict" ? "strict" : DEFAULT_MODE);
    if (!MODE_VALUES.includes(targetMode)) return fail("unknown_delivery_mode", `unknown delivery mode: ${targetMode}`);
    if (row.mode === "strict" && targetMode !== "strict") return fail("mode_downgrade_forbidden", "a strict flow cannot be downgraded in place");
    const actionSignals = JSON.parse(row.external_actions_json || "[]").length ? ["external-action"] : [];
    try {
      const selection = requestedMode({ mode: targetMode, mode_reason: input.mode_reason, strict_signals: actionSignals });
      return this.commitTransition({
        flow_id: row.flow_id, expected_revision: row.revision, request_digest: input.request_digest,
        event: "policy-migrated", reason: input.reason || "explicit policy migration", bypass_policy_check: true,
        patch: { ...currentPolicy(selection.mode, selection.mode_reason), resume_point: input.resume_point || "Policy migrated; resume from the recorded phase and verify current evidence" }
      });
    } catch (error) { return fail(error.code || "policy_migration_failed", error.message, error.signals ? { signals: error.signals } : {}); }
  }

  metric(metric, dimension) {
    this.db.prepare(`INSERT INTO metric_aggregates(metric,dimension,value) VALUES(?,?,1)
      ON CONFLICT(metric,dimension) DO UPDATE SET value=value+1`).run(metric, dimension);
  }

  acquireLease(flowId, owner, leaseMs = DEFAULT_LEASE_MS) {
    const at = this.clock();
    const row = this.db.prepare("SELECT * FROM leases WHERE flow_id=?").get(flowId);
    if (row && row.expires_at > at && row.owner !== owner) throw Object.assign(new Error("flow lease is held by another writer"), { code: "lease_conflict" });
    this.db.prepare(`INSERT INTO leases(flow_id,owner,expires_at) VALUES(?,?,?)
      ON CONFLICT(flow_id) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at`).run(flowId, owner, at + leaseMs);
  }

  initializeFlow(input) {
    try {
      if (input.expected_revision !== 0) return fail("revision_conflict", "initialize_flow requires expected_revision 0");
      assertString(input.request_digest, "request_digest");
      if (!/^sha256:[0-9a-f]{64}$/.test(input.request_digest)) return fail("invalid_request_digest", "request_digest must be sha256:<64 lowercase hex>");
      const { rootPath, targetPath } = contained(input.plan_root, input.plan_target);
      if (!existsSync(targetPath) || !statSync(targetPath).isFile()) return fail("plan_target_missing", "Plan Tree target must already exist");
      const modeSelection = requestedMode(input);
      for (const action of input.external_actions || []) {
        if (!SENSITIVE_ACTIONS.has(action.action)) return fail("action_not_controlled", `external action is not in the controlled set: ${action.action}`);
        if (!/^sha256:[0-9a-f]{64}$/.test(action.request_digest || "")) return fail("authorization_digest_required", `external action ${action.action} requires an exact request_digest`);
      }
      const flowId = input.flow_id || randomUUID();
      if (this.row(flowId)) return fail("flow_exists", `flow already exists: ${flowId}`);
      const current = readText(targetPath);
      let imported = null;
      try { imported = parseStateBlock(current); } catch {}
      imported ??= parseLegacyBlock(current, targetPath);
      const requestedCurrent = input.current_phase || "route";
      const requestedNext = input.next_phase || "clarify";
      if (!imported && (requestedCurrent !== "route" || requestedNext !== "clarify")) return fail("flow_must_start_at_route", "new flows must start at route -> clarify; use recover_flow to import an existing Plan Tree state");
      const state = normalizeState(imported ? { ...imported, flow_id: flowId, plan_target: targetPath } : {
        flow_id: flowId, revision: 0, flow: input.flow || "main", status: "active", current_phase: "route",
        next_phase: "clarify", plan_target: targetPath,
        terminal_condition: input.terminal_condition, resume_point: input.resume_point,
        delivery_generation: 1, scope_digest: input.scope_digest,
        acceptance_criteria: input.acceptance_criteria || [], required_evidence_types: input.required_evidence_types || [],
        external_actions: input.external_actions || [], correlation_id: input.correlation_id || null, plan_sync: "not-requested",
        ...currentPolicy(modeSelection.mode, modeSelection.mode_reason)
      });
      const projected = replaceStateBlock(current, state);
      const txId = randomUUID();
      const stateDigest = controlledStateDigest(state);
      const at = nowIso(this.clock);
      this.transaction(() => {
        const existingFlow = this.row(flowId);
        if (existingFlow) throw Object.assign(new Error(`flow already exists: ${flowId}`), { code: "flow_exists" });
        const targetOwner = this.db.prepare("SELECT flow_id FROM flows WHERE plan_target=? LIMIT 1").get(targetPath);
        if (targetOwner) throw Object.assign(new Error("Plan Tree target is already controlled by another flow"), { code: "plan_target_bound", flow_id: targetOwner.flow_id });
        const targetMarker = `"plan_target":${JSON.stringify(targetPath)}`;
        const pending = this.db.prepare("SELECT flow_id FROM pending_transactions WHERE (flow_id=? OR instr(new_state,?)>0 OR instr(old_state,?)>0) AND stage IN ('prepared','projected') LIMIT 1").get(flowId, targetMarker, targetMarker);
        if (pending) throw Object.assign(new Error("flow initialization is already in progress for this flow or Plan Tree target"), { code: "flow_initializing", flow_id: pending.flow_id });
        this.db.prepare(`INSERT INTO pending_transactions(transaction_id,flow_id,expected_revision,target_revision,stage,old_digest,new_digest,
          old_state,new_state,request_digest,reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          txId, flowId, 0, state.revision, "prepared", sha256(Buffer.from(current)), stateDigest,
          "", JSON.stringify(state), input.request_digest, "initialize flow", at, at);
      });
      this.fault("after_initialize_prepare", { transaction_id: txId });
      if (readText(targetPath) !== current) {
        this.transaction(() => this.db.prepare("UPDATE pending_transactions SET stage='rolled-back',updated_at=? WHERE transaction_id=? AND stage='prepared'").run(nowIso(this.clock), txId));
        return fail("plan_target_changed", "Plan Tree target changed before initialization could be projected");
      }
      const paths = atomicProject(targetPath, projected, txId);
      this.fault("after_initialize_project", { transaction_id: txId });
      const digest = fileDigest(targetPath);
      this.transaction(() => {
        this.db.prepare(`INSERT INTO flows(flow_id,revision,plan_root,plan_target,flow,status,current_phase,next_phase,terminal_condition,resume_point,
        plan_tree_digest,state_digest,mode,mode_reason,policy_id,policy_version,policy_digest,native_plan_digest,plan_sync,frozen,drift_report,route_json,acceptance_json,required_types_json,external_actions_json,gate_json,
          delivery_generation,scope_digest,fixed_point_json,external_action_results_json,correlation_id,receipt_digest,evidence_json,authorization_receipts_json,history_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          flowId, state.revision, rootPath, targetPath, state.flow, state.status, state.current_phase, state.next_phase,
          state.terminal_condition, state.resume_point, digest, stateDigest, state.mode, state.mode_reason, state.policy_id, state.policy_version, state.policy_digest, state.native_plan_digest, state.plan_sync, 0, null, state.route ? JSON.stringify(state.route) : null,
          JSON.stringify(state.acceptance_criteria), JSON.stringify(state.required_evidence_types), JSON.stringify(state.external_actions), gateJson(state),
          state.delivery_generation, state.scope_digest, JSON.stringify(state.fixed_point), JSON.stringify(state.external_action_results),
          state.correlation_id, state.receipt_digest, JSON.stringify(state.evidence_records), JSON.stringify(state.authorization_receipts), JSON.stringify(state.history), at, at);
        this.db.prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?)").run(randomUUID(), flowId, state.revision, "initialized", input.request_digest, null, JSON.stringify(state), "flow initialized", at);
        this.db.prepare("UPDATE pending_transactions SET stage='committed',backup_path=?,temp_path=?,updated_at=? WHERE transaction_id=?").run(paths.backup, paths.temp, nowIso(this.clock), txId);
        this.syncActionResultCache(state.flow_id, state.external_action_results);
        this.metric("flow", "initialized");
      });
      this.fault("after_initialize_commit", { transaction_id: txId });
      return ok({ flow: publicFlow(this.row(flowId)), imported_legacy: Boolean(imported) });
    } catch (error) { return fail(error.code || "initialize_failed", error.message); }
  }

  inspectFlow(flowId) {
    const row = this.row(flowId);
    return row ? ok({ flow: publicFlow(row) }) : fail("flow_not_found", `unknown flow: ${flowId}`);
  }

  startOrResumeFlow(input) {
    const request_digest = mutationDigest("start_or_resume_flow", input);
    const external_actions = (input.external_actions || []).map((action) => ({
      ...action,
      request_digest: action.request_digest || sha256(canonical({ action: action.action, target: action.target, environment: action.environment, request_summary: action.request_summary || null }))
    }));
    input = { ...input, request_digest, external_actions };
    if (input.flow_id && (this.row(input.flow_id) || this.db.prepare("SELECT 1 FROM pending_transactions WHERE flow_id=? AND stage IN ('prepared','projected')").get(input.flow_id))) {
      return this.recoverFlow({ flow_id: input.flow_id, expected_revision: input.expected_revision, request_digest: input.request_digest, plan_root: input.plan_root, plan_target: input.plan_target });
    }
    return this.initializeFlow(input);
  }

  routeFlow(input) {
    return this.selectRoute({ ...input, request_digest: mutationDigest("route_flow", input) });
  }

  checkpointFlow(input) {
    const request_digest = mutationDigest("checkpoint_flow", input);
    if (input.kind === "phase") return this.advancePhase({ ...input, request_digest });
    if (input.kind === "scope-change") return this.reviseScope({ ...input, request_digest });
    if (input.kind === "migrate-policy") return this.migratePolicy({ ...input, request_digest });
    if (input.kind === "resolve-drift") return this.resolveDrift({ ...input, request_digest });
    return fail("unknown_checkpoint_kind", "checkpoint kind must be phase, scope-change, migrate-policy, or resolve-drift");
  }

  recordEvidence(input) {
    const request_digest = mutationDigest("record_evidence", input);
    if (input.kind === "delivery") return this.recordDeliveryEvidence({ ...input, request_digest });
    if (input.kind === "review") return this.recordReviewFindings({ ...input, request_digest });
    return fail("unknown_evidence_kind", "evidence kind must be delivery or review");
  }

  authorizeExternalAction(input) {
    if (input.kind === "confirm" && !input.mode && input.confirmation_mode) input = { ...input, mode: input.confirmation_mode };
    const control_request_digest = mutationDigest("authorize_external_action", input);
    const request_digest = externalDigest(input);
    if (input.kind === "request") return this.requestAuthorization({ ...input, request_digest, control_request_digest });
    if (input.kind === "confirm") return this.confirmAuthorization({ ...input, request_digest, control_request_digest });
    if (input.kind === "consume") return this.consumeAuthorization({ ...input, request_digest, control_request_digest });
    if (input.kind === "record-result") {
      const result = { ...input.result, action_request_digest: request_digest };
      return this.recordExternalActionResult({ ...input, request_digest: control_request_digest, result });
    }
    return fail("unknown_authorization_kind", "authorization kind must be request, confirm, consume, or record-result");
  }

  auditOrRecoverFlow(input) {
    if (input.kind === "audit") {
      const inspected = this.inspectFlow(input.flow_id);
      if (!inspected.ok) return inspected;
      return ok({ ...inspected, consistency: this.auditConsistency(input.flow_id), policy: this.policyStatus(this.row(input.flow_id)) });
    }
    if (input.kind === "recover") return this.recoverFlow({ ...input, request_digest: mutationDigest("audit_or_recover_flow", input) });
    return fail("unknown_audit_kind", "audit kind must be audit or recover");
  }

  closeOrCancelFlow(input) {
    const request_digest = mutationDigest("close_or_cancel_flow", input);
    if (input.kind === "close") return this.closeFlow({ ...input, request_digest });
    if (input.kind === "cancel") return this.cancelFlow({ ...input, request_digest });
    return fail("unknown_close_kind", "close kind must be close or cancel");
  }

  advanceFlow(input) {
    // Kept for local compatibility only. A host plan is an advisory runtime view,
    // not a side effect of a durable transition and never a delivery gate.
    return this.commitTransition(input);
  }

  completePhase(input) {
    const row = this.row(input.flow_id);
    if (!row) return fail("flow_not_found", `unknown flow: ${input.flow_id}`);
    if (row.revision !== input.expected_revision) return fail("revision_conflict", "expected_revision is stale", { actual: row.revision });
    if (input.outcome !== "completed") return fail("phase_not_completed", "only a completed phase can advance the fixed point");
    if (!["spec", "execute", "review"].includes(input.phase)) return fail("phase_has_no_fixed_point", `phase does not own a fixed point: ${input.phase}`);
    if (row.current_phase !== input.phase) return fail("phase_mismatch", `current phase is ${row.current_phase}, not ${input.phase}`);
    if (!/^sha256:[0-9a-f]{64}$/.test(input.artifact_digest || "")) return fail("invalid_artifact_digest", "artifact_digest must be sha256:<64 lowercase hex>");
    const state = publicFlow(row);
    const field = input.phase === "spec" ? "spec_digest" : input.phase === "execute" ? "implementation_digest" : "review_digest";
    const fixedPoint = { ...state.fixed_point, generation: state.delivery_generation, [field]: input.artifact_digest };
    if (field === "spec_digest") {
      fixedPoint.implementation_digest = null;
      fixedPoint.review_digest = null;
    } else if (field === "implementation_digest") fixedPoint.review_digest = null;
    return this.commitTransition({
      flow_id: row.flow_id, expected_revision: row.revision, request_digest: input.request_digest,
      event: "phase-completed", reason: input.reason || `complete ${input.phase} fixed point`, patch: { fixed_point: fixedPoint }
    });
  }

  reviseScope(input) {
    const row = this.row(input.flow_id);
    if (!row) return fail("flow_not_found", `unknown flow: ${input.flow_id}`);
    if (row.revision !== input.expected_revision) return fail("revision_conflict", "expected_revision is stale", { actual: row.revision });
    if (!/^sha256:[0-9a-f]{64}$/.test(input.scope_digest || "")) return fail("invalid_scope_digest", "scope_digest must be sha256:<64 lowercase hex>");
    if (input.scope_digest === row.scope_digest) return fail("scope_unchanged", "scope_digest is unchanged");
    const generation = row.delivery_generation + 1;
    return this.commitTransition({
      flow_id: row.flow_id, expected_revision: row.revision, request_digest: input.request_digest,
      event: "scope-change", reason: assertString(input.reason, "reason"), patch: {
        delivery_generation: generation, scope_digest: input.scope_digest,
        fixed_point: { generation, spec_digest: null, implementation_digest: null, review_digest: null },
        status: "active", current_phase: "route", next_phase: "clarify", route: null,
        plan_sync: "pending", native_plan_digest: null,
        resume_point: `Delivery generation ${generation} requires routing and fresh fixed-point evidence`
      }
    });
  }

  recordDeliveryEvidence(input) {
    const recorded = this.addEvidence(input);
    if (!recorded.ok) return recorded;
    return ok({ flow: recorded.flow, validation: this.validateEvidence({ flow_id: input.flow_id }) });
  }

  recordReviewFindings(input) {
    const row = this.row(input.flow_id);
    if (!row) return fail("flow_not_found", `unknown flow: ${input.flow_id}`);
    if (!Array.isArray(input.review_findings)) return fail("invalid_review_findings", "review_findings must be an array");
    const previous = publicFlow(row).review_findings || [];
    const incoming = new Map(input.review_findings.map((finding) => [finding.finding_id, finding]));
    const merged = previous.map((finding) => incoming.get(finding.finding_id) || finding);
    for (const finding of input.review_findings) if (!previous.some((item) => item.finding_id === finding.finding_id)) merged.push(finding);
    return this.commitTransition({ flow_id: input.flow_id, expected_revision: input.expected_revision, request_digest: input.request_digest, event: "review-recorded", reason: input.reason || "record review dispositions", patch: { review_findings: merged } });
  }

  closeVerifiedFlow(input) {
    return this.closeFlow(input);
  }

  selectRoute(input) {
    const row = this.row(input.flow_id);
    if (!row) return fail("flow_not_found", `unknown flow: ${input.flow_id}`);
    const policy = this.policyStatus(row);
    if (!policy.ok) return policy;
    if (Object.prototype.hasOwnProperty.call(input, "skipped_phases") || Object.prototype.hasOwnProperty.call(input, "next_phase")) return fail("caller_phase_arithmetic_forbidden", "route phases and next_phase are derived by the controller");
    if (input.approved_spec === true && !/^sha256:[0-9a-f]{64}$/.test(input.approved_spec_digest || "")) return fail("approved_spec_digest_required", "approved_spec requires approved_spec_digest");
    let modeSelection;
    try {
      modeSelection = requestedMode({
        mode: input.mode || row.mode,
        mode_reason: input.mode_reason,
        strict_signals: input.strict_signals || [],
        external_actions: JSON.parse(row.external_actions_json || "[]")
      });
    } catch (error) { return fail(error.code || "route_mode_failed", error.message, error.signals ? { signals: error.signals } : {}); }
    if (row.mode === "strict" && modeSelection.mode !== "strict") return fail("mode_downgrade_forbidden", "a strict flow cannot be downgraded in place");
    const phaseSequence = routeSequence(row.flow, { setupRequired: input.setup_required === true, approvedSpec: input.approved_spec === true });
    const skipped = skippedPhases(phaseSequence);
    const route = {
      chosen_procedure: assertString(input.chosen_procedure, "chosen_procedure"),
      why: assertString(input.why, "why"), skipped_phases: skipped,
      phase_sequence: phaseSequence, template: row.flow, setup_required: input.setup_required === true,
      confidence: input.confidence || "high", approved_spec: input.approved_spec === true,
      approved_spec_digest: input.approved_spec_digest || null, selected_at: nowIso(this.clock)
    };
    const nextPhase = phaseSequence[1] || "close";
    const awaiting = route.confidence === "low" && input.confirmed !== true;
    const state = publicFlow(row);
    const patch = { route, status: awaiting ? "awaiting-user" : "active", next_phase: awaiting ? "route" : nextPhase, plan_sync: "not-requested", native_plan_digest: null };
    if (modeSelection.mode !== row.mode) Object.assign(patch, currentPolicy(modeSelection.mode, modeSelection.mode_reason));
    if (input.approved_spec === true) patch.fixed_point = { ...state.fixed_point, spec_digest: input.approved_spec_digest, implementation_digest: null, review_digest: null };
    if (awaiting) patch.resume_point = "Route confidence is low; user must confirm the selected route";
    return this.commitTransition({ ...input, event: "route-selected", reason: input.reason || route.why, patch });
  }

  advancePhase(input) {
    const row = this.row(input.flow_id);
    if (!row) return fail("flow_not_found", `unknown flow: ${input.flow_id}`);
    if (row.revision !== input.expected_revision) return fail("revision_conflict", "expected_revision is stale", { actual: row.revision });
    if (row.current_phase !== input.phase) return fail("phase_mismatch", `current phase is ${row.current_phase}, not ${input.phase}`);
    const state = publicFlow(row);
    if (!state.route?.phase_sequence) return fail("route_required", "select a route template before advancing phases");
    const outcome = input.outcome || "completed";
    if (outcome === "failed") return this.commitTransition({ ...input, event: "unrecoverable-failure", reason: input.reason || `${input.phase} failed`, patch: { status: "failed", next_phase: "none", plan_sync: "pending", native_plan_digest: null, resume_point: input.resume_point || `${input.phase} failed; inspect evidence before retry` } });
    if (["awaiting-user", "blocked-external", "partial"].includes(outcome)) {
      const status = outcome;
      const event = outcome === "awaiting-user" ? "user-decision-needed" : outcome === "blocked-external" ? "external-blocker" : "partial-result";
      return this.commitTransition({ ...input, event, reason: input.reason || `${input.phase} is ${outcome}`, patch: { status, next_phase: input.phase, plan_sync: "pending", native_plan_digest: null, resume_point: input.resume_point || `${input.phase} awaits resolution` } });
    }
    if (outcome !== "completed") return fail("invalid_phase_outcome", `unknown phase outcome: ${outcome}`);
    const nextPhase = nextInRoute(state.route, input.phase);
    if (!nextPhase || nextPhase === "none") return fail("close_flow_required", "use close_flow to complete the final route phase");
    const patch = nextPhase === "close"
      ? { status: "active", current_phase: input.phase, next_phase: "close", resume_point: input.resume_point || "Review fixed point recorded; verify close gates" }
      : { status: "active", current_phase: nextPhase, next_phase: nextInRoute(state.route, nextPhase) || "none", resume_point: input.resume_point || `Continue ${nextPhase}` };
    patch.plan_sync = "not-requested";
    patch.native_plan_digest = null;
    if (FIXED_POINT_PHASES.includes(input.phase) && MODE_PROFILES[state.mode]?.require_fixed_points) {
      if (!/^sha256:[0-9a-f]{64}$/.test(input.artifact_digest || "")) return fail("fixed_point_digest_required", `${input.phase} completion requires artifact_digest in strict mode`);
      const field = input.phase === "spec" ? "spec_digest" : input.phase === "execute" ? "implementation_digest" : "review_digest";
      patch.fixed_point = { ...state.fixed_point, [field]: input.artifact_digest };
      if (field === "spec_digest") { patch.fixed_point.implementation_digest = null; patch.fixed_point.review_digest = null; }
      if (field === "implementation_digest") patch.fixed_point.review_digest = null;
    }
    const committed = this.commitTransition({ ...input, event: "phase-completed", reason: input.reason || `complete ${input.phase}`, patch });
    if (!committed.ok) return committed;
    return ok({ flow: committed.flow });
  }

  proposeTransition(input) {
    try {
      const row = this.row(input.flow_id);
      if (!row) return fail("flow_not_found", `unknown flow: ${input.flow_id}`);
      if (!input.bypass_policy_check) {
        const policy = this.policyStatus(row);
        if (!policy.ok) return policy;
      }
      if (row.frozen) return fail("flow_frozen", "flow is frozen pending drift resolution", { drift_report: JSON.parse(row.drift_report) });
      if (row.revision !== input.expected_revision) return fail("revision_conflict", "expected_revision is stale", { expected: input.expected_revision, actual: row.revision });
      const state = publicFlow(row);
      const next = normalizeState({ ...state, ...input.patch, revision: row.revision + 1 });
      validateTransition(state, next, input.event || "advance");
      if (next.status === "complete" && input.event !== "terminal-verified") return fail("completion_gate_required", "use close_flow to complete a flow");
      const requestDigest = input.request_digest || sha256(canonical({ flow_id: input.flow_id, expected_revision: input.expected_revision, event: input.event, patch: input.patch, reason: input.reason }));
      if (!/^sha256:[0-9a-f]{64}$/.test(requestDigest)) throw Object.assign(new Error("request_digest must be sha256:<64 lowercase hex>"), { code: "invalid_request_digest" });
      return ok({ proposal: { flow_id: input.flow_id, expected_revision: row.revision, target_revision: next.revision, event: input.event || "advance", reason: assertString(input.reason, "reason"), request_digest: requestDigest, state: next } });
    } catch (error) { return fail(error.code || "proposal_failed", error.message); }
  }

  commitTransition(input) {
    const proposed = input.proposal ? ok({ proposal: input.proposal }) : this.proposeTransition(input);
    if (!proposed.ok) return proposed;
    const proposal = proposed.proposal;
    const owner = input.lease_owner || `controller:${randomUUID()}`;
    let row;
    let oldText;
    let newText;
    let txId;
    try {
      this.transaction(() => {
        row = this.row(proposal.flow_id);
        if (!row) throw Object.assign(new Error("flow not found"), { code: "flow_not_found" });
        if (row.frozen) throw Object.assign(new Error("flow is frozen"), { code: "flow_frozen" });
        if (row.revision !== proposal.expected_revision) throw Object.assign(new Error("expected_revision is stale"), { code: "revision_conflict", actual: row.revision });
        if (MODE_PROFILES[row.mode]?.require_lease) this.acquireLease(row.flow_id, owner, input.lease_ms);
        oldText = readText(row.plan_target);
        const actualDigest = stateBlockDigest(oldText);
        if (actualDigest !== row.state_digest) throw Object.assign(new Error("controlled Plan Tree state changed outside delivery-control"), { code: "plan_tree_drift", expected: row.state_digest, actual: actualDigest });
        const state = normalizeState({ ...proposal.state, plan_target: row.plan_target });
        state.history = [...state.history, { event_id: randomUUID(), revision: state.revision, event: proposal.event || "advance", reason: proposal.reason, request_digest: proposal.request_digest, previous_status: row.status, previous_phase: row.current_phase, new_status: state.status, new_phase: state.current_phase, observed_at: nowIso(this.clock) }];
        proposal.state = state;
        newText = replaceStateBlock(oldText, state);
        txId = randomUUID();
        this.db.prepare(`INSERT INTO pending_transactions(transaction_id,flow_id,expected_revision,target_revision,stage,old_digest,new_digest,
          old_state,new_state,request_digest,reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          txId, row.flow_id, row.revision, state.revision, "prepared", row.state_digest, controlledStateDigest(state),
          JSON.stringify(publicFlow(row)), JSON.stringify(state), proposal.request_digest, proposal.reason, nowIso(this.clock), nowIso(this.clock));
      });
      this.fault("after_prepare", { transaction_id: txId });
      const latestText = readText(row.plan_target);
      if (latestText !== oldText) {
        const latestDigest = stateBlockDigest(latestText);
        if (latestDigest !== row.state_digest) {
          const fresh = this.row(row.flow_id);
          const siblingProjection = this.db.prepare("SELECT transaction_id,target_revision FROM pending_transactions WHERE flow_id=? AND transaction_id<>? AND stage IN ('prepared','projected') AND new_digest=? ORDER BY created_at DESC LIMIT 1").get(row.flow_id, txId, latestDigest);
          if (fresh?.revision !== proposal.expected_revision || siblingProjection) throw Object.assign(new Error("another writer committed or projected first"), { code: "revision_conflict", actual: fresh?.revision ?? siblingProjection?.target_revision });
          throw Object.assign(new Error("controlled Plan Tree state changed during projection"), { code: "plan_tree_drift", expected: row.state_digest, actual: latestDigest });
        }
        oldText = latestText;
        newText = replaceStateBlock(latestText, proposal.state);
      }
      const paths = atomicProject(row.plan_target, newText, txId);
      this.fault("after_project", { transaction_id: txId });
      this.transaction(() => {
        const current = this.row(row.flow_id);
        if (current.revision !== proposal.expected_revision) throw Object.assign(new Error("revision changed during projection"), { code: "revision_conflict" });
        const digest = fileDigest(row.plan_target);
        const stateDigest = stateBlockDigest(readText(row.plan_target));
        const expectedDigest = controlledStateDigest(proposal.state);
        if (stateDigest !== expectedDigest) throw Object.assign(new Error("projected Plan Tree state digest mismatch"), { code: "projection_digest_mismatch" });
        const state = normalizeState(proposal.state);
        this.db.prepare(`UPDATE pending_transactions SET stage='projected',backup_path=?,temp_path=?,updated_at=? WHERE transaction_id=?`).run(paths.backup, paths.temp, nowIso(this.clock), txId);
        this.db.prepare(`UPDATE flows SET revision=?,flow=?,status=?,current_phase=?,next_phase=?,terminal_condition=?,resume_point=?,plan_tree_digest=?,state_digest=?,mode=?,mode_reason=?,policy_id=?,policy_version=?,policy_digest=?,
          native_plan_digest=?,plan_sync=?,route_json=?,acceptance_json=?,required_types_json=?,external_actions_json=?,gate_json=?,delivery_generation=?,scope_digest=?,fixed_point_json=?,external_action_results_json=?,correlation_id=?,receipt_digest=?,evidence_json=?,authorization_receipts_json=?,history_json=?,updated_at=? WHERE flow_id=?`).run(
          state.revision, state.flow, state.status, state.current_phase, state.next_phase, state.terminal_condition, state.resume_point,
          digest, stateDigest, state.mode, state.mode_reason, state.policy_id, state.policy_version, state.policy_digest, state.native_plan_digest, state.plan_sync, state.route ? JSON.stringify(state.route) : null, JSON.stringify(state.acceptance_criteria),
          JSON.stringify(state.required_evidence_types), JSON.stringify(state.external_actions), gateJson(state), state.delivery_generation, state.scope_digest, JSON.stringify(state.fixed_point), JSON.stringify(state.external_action_results), state.correlation_id, state.receipt_digest,
          JSON.stringify(state.evidence_records), JSON.stringify(state.authorization_receipts), JSON.stringify(state.history), nowIso(this.clock), row.flow_id);
        this.syncActionResultCache(state.flow_id, state.external_action_results);
        this.db.prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?)").run(randomUUID(), row.flow_id, state.revision, proposal.event || "advance", proposal.request_digest, JSON.stringify(publicFlow(row)), JSON.stringify(state), proposal.reason, nowIso(this.clock));
        this.db.prepare("UPDATE pending_transactions SET stage='committed',updated_at=? WHERE transaction_id=?").run(nowIso(this.clock), txId);
        this.db.prepare("DELETE FROM leases WHERE flow_id=? AND owner=?").run(row.flow_id, owner);
        this.metric("transition", proposal.event || "advance");
      });
      this.fault("after_commit", { transaction_id: txId });
      return ok({ transaction_id: txId, flow: publicFlow(this.row(row.flow_id)) });
    } catch (error) {
      if (error.code === "revision_conflict" && txId) {
        try { this.transaction(() => this.db.prepare("UPDATE pending_transactions SET stage='rolled-back',updated_at=? WHERE transaction_id=? AND stage='prepared'").run(nowIso(this.clock), txId)); } catch {}
      }
      if (error.code === "plan_tree_drift" && row) this.freezeForDrift(row.flow_id, { detected_at: nowIso(this.clock), expected_digest: error.expected, actual_digest: error.actual, source: "commit_transition" });
      return fail(error.code || "transition_failed", error.message, error.actual !== undefined ? { actual: error.actual } : {});
    }
  }

  freezeForDrift(flowId, report) {
    this.transaction(() => {
      this.db.prepare("UPDATE flows SET frozen=1,status='awaiting-user',drift_report=?,updated_at=? WHERE flow_id=?").run(JSON.stringify(report), nowIso(this.clock), flowId);
      this.metric("consistency", "drift");
    });
  }

  recoverFlow(input) {
    try {
      let row = this.row(input.flow_id);
      if (!row) {
        if (input.expected_revision !== 0) return fail("revision_conflict", "rebuild requires expected_revision 0");
        if (!/^sha256:[0-9a-f]{64}$/.test(input.request_digest || "")) return fail("invalid_request_digest", "request_digest must be sha256:<64 lowercase hex>");
        if (!input.plan_root || !input.plan_target) return fail("rebuild_requires_plan", "plan_root and plan_target are required to rebuild a missing database flow");
        const { rootPath, targetPath } = contained(input.plan_root, input.plan_target);
        const text = readText(targetPath);
        const initialization = this.db.prepare("SELECT * FROM pending_transactions WHERE flow_id=? AND stage IN ('prepared','projected') ORDER BY created_at DESC LIMIT 1").get(input.flow_id);
        let state;
        try { state = parseStateBlock(text); }
        catch (error) {
          if (initialization && sha256(Buffer.from(text)) === initialization.old_digest) {
            this.transaction(() => this.db.prepare("UPDATE pending_transactions SET stage='rolled-back',updated_at=? WHERE transaction_id=?").run(nowIso(this.clock), initialization.transaction_id));
            return ok({ action: "rolled-back-initialization", flow: null });
          }
          return fail("unresolved_drift", "initialization state is missing or invalid after an interrupted write", { transaction_id: initialization?.transaction_id || null });
        }
        if (state.flow_id !== input.flow_id) return fail("flow_identity_mismatch", "Plan Tree flow_id does not match requested flow");
        const at = nowIso(this.clock);
        this.transaction(() => this.db.prepare(`INSERT INTO flows(flow_id,revision,plan_root,plan_target,flow,status,current_phase,next_phase,terminal_condition,resume_point,
          plan_tree_digest,state_digest,mode,mode_reason,policy_id,policy_version,policy_digest,native_plan_digest,plan_sync,frozen,drift_report,route_json,acceptance_json,required_types_json,external_actions_json,gate_json,
          delivery_generation,scope_digest,fixed_point_json,external_action_results_json,correlation_id,receipt_digest,evidence_json,authorization_receipts_json,history_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          state.flow_id, state.revision, rootPath, targetPath, state.flow, state.status, state.current_phase, state.next_phase,
          state.terminal_condition, state.resume_point, fileDigest(targetPath), controlledStateDigest(state), state.mode, state.mode_reason, state.policy_id, state.policy_version, state.policy_digest, state.native_plan_digest, state.plan_sync, 0, null,
          state.route ? JSON.stringify(state.route) : null, JSON.stringify(state.acceptance_criteria), JSON.stringify(state.required_evidence_types),
          JSON.stringify(state.external_actions), gateJson(state), state.delivery_generation, state.scope_digest, JSON.stringify(state.fixed_point), JSON.stringify(state.external_action_results), state.correlation_id, state.receipt_digest, JSON.stringify(state.evidence_records), JSON.stringify(state.authorization_receipts), JSON.stringify(state.history), at, at));
        this.syncEvidenceCache(state.flow_id, state.evidence_records);
        this.syncActionResultCache(state.flow_id, state.external_action_results);
        this.rebuildMetricsCache(state.flow_id, state.history);
        if (initialization) {
          const actual = controlledStateDigest(state);
          if (actual !== initialization.new_digest) return fail("unresolved_drift", "initialization state does not match its transaction journal", { transaction_id: initialization.transaction_id });
          this.transaction(() => this.db.prepare("UPDATE pending_transactions SET stage='committed',updated_at=? WHERE transaction_id=?").run(nowIso(this.clock), initialization.transaction_id));
        }
        row = this.row(input.flow_id);
        return ok({ action: initialization ? "completed-initialization-recovery" : "rebuilt-from-plan-tree", flow: publicFlow(row) });
      }
      if (row.revision !== input.expected_revision) return fail("revision_conflict", "expected_revision is stale", { actual: row.revision });
      if (!/^sha256:[0-9a-f]{64}$/.test(input.request_digest || "")) return fail("invalid_request_digest", "request_digest must be sha256:<64 lowercase hex>");
      const recoveryOwner = input.lease_owner || `recovery:${randomUUID()}`;
      try { this.transaction(() => { if (MODE_PROFILES[row.mode]?.require_lease) this.acquireLease(row.flow_id, recoveryOwner, input.lease_ms); }); }
      catch (error) { return fail(error.code || "lease_conflict", error.message); }
      const pending = this.db.prepare("SELECT * FROM pending_transactions WHERE flow_id=? AND stage IN ('prepared','projected') ORDER BY created_at").all(input.flow_id);
      const actions = [];
      for (const tx of pending) {
        const actual = stateBlockDigest(readText(row.plan_target));
        if (actual === tx.new_digest) {
          const state = normalizeState(JSON.parse(tx.new_state));
          this.transaction(() => {
            this.db.prepare(`UPDATE flows SET revision=?,flow=?,status=?,current_phase=?,next_phase=?,terminal_condition=?,resume_point=?,plan_tree_digest=?,state_digest=?,mode=?,mode_reason=?,policy_id=?,policy_version=?,policy_digest=?,
              native_plan_digest=?,plan_sync=?,route_json=?,acceptance_json=?,required_types_json=?,external_actions_json=?,gate_json=?,delivery_generation=?,scope_digest=?,fixed_point_json=?,external_action_results_json=?,correlation_id=?,receipt_digest=?,evidence_json=?,authorization_receipts_json=?,history_json=?,updated_at=? WHERE flow_id=?`).run(
              state.revision, state.flow, state.status, state.current_phase, state.next_phase, state.terminal_condition, state.resume_point,
              fileDigest(row.plan_target), actual, state.mode, state.mode_reason, state.policy_id, state.policy_version, state.policy_digest, state.native_plan_digest, state.plan_sync, state.route ? JSON.stringify(state.route) : null, JSON.stringify(state.acceptance_criteria), JSON.stringify(state.required_evidence_types),
              JSON.stringify(state.external_actions), gateJson(state), state.delivery_generation, state.scope_digest, JSON.stringify(state.fixed_point), JSON.stringify(state.external_action_results), state.correlation_id, state.receipt_digest, JSON.stringify(state.evidence_records), JSON.stringify(state.authorization_receipts), JSON.stringify(state.history), nowIso(this.clock), row.flow_id);
            this.syncEvidenceCache(state.flow_id, state.evidence_records);
            this.syncActionResultCache(state.flow_id, state.external_action_results);
            this.db.prepare("UPDATE pending_transactions SET stage='committed',updated_at=? WHERE transaction_id=?").run(nowIso(this.clock), tx.transaction_id);
            this.db.prepare("DELETE FROM leases WHERE flow_id=?").run(row.flow_id);
          });
          actions.push({ transaction_id: tx.transaction_id, action: "completed-projected-transaction" });
        } else if (actual === tx.old_digest) {
          this.transaction(() => {
            this.db.prepare("UPDATE pending_transactions SET stage='rolled-back',updated_at=? WHERE transaction_id=?").run(nowIso(this.clock), tx.transaction_id);
            this.db.prepare("DELETE FROM leases WHERE flow_id=?").run(row.flow_id);
          });
          actions.push({ transaction_id: tx.transaction_id, action: "rolled-back-prepared-transaction" });
        } else {
          const report = { detected_at: nowIso(this.clock), transaction_id: tx.transaction_id, old_digest: tx.old_digest, projected_digest: tx.new_digest, actual_digest: actual, source: "recover_flow" };
          this.freezeForDrift(row.flow_id, report);
          this.transaction(() => this.db.prepare("DELETE FROM leases WHERE flow_id=? AND owner=?").run(row.flow_id, recoveryOwner));
          return fail("unresolved_drift", "Plan Tree conflicts with both journal versions", { drift_report: report });
        }
      }
      row = this.row(input.flow_id);
      if (!pending.length) {
        const actual = stateBlockDigest(readText(row.plan_target));
        if (actual !== row.state_digest) {
          const report = { detected_at: nowIso(this.clock), expected_digest: row.state_digest, actual_digest: actual, source: "recover_flow" };
          this.freezeForDrift(row.flow_id, report);
          this.transaction(() => this.db.prepare("DELETE FROM leases WHERE flow_id=? AND owner=?").run(row.flow_id, recoveryOwner));
          return fail("unresolved_drift", "Plan Tree changed outside the transaction log", { drift_report: report });
        }
      }
      this.transaction(() => this.db.prepare("DELETE FROM leases WHERE flow_id=? AND owner=?").run(row.flow_id, recoveryOwner));
      return ok({ action: actions.length ? "reconciled" : "already-consistent", actions, flow: publicFlow(this.row(input.flow_id)) });
    } catch (error) { return fail(error.code || "recovery_failed", error.message); }
  }

  resolveDrift(input) {
    try {
      const row = this.row(input.flow_id);
      if (!row) return fail("flow_not_found", `unknown flow: ${input.flow_id}`);
      const policy = this.policyStatus(row);
      if (!policy.ok) return policy;
      if (row.revision !== input.expected_revision) return fail("revision_conflict", "expected_revision is stale", { actual: row.revision });
      if (!/^sha256:[0-9a-f]{64}$/.test(input.request_digest || "")) return fail("invalid_request_digest", "request_digest must be sha256:<64 lowercase hex>");
      if (input.resolution !== "accept-restored-plan-tree") return fail("resolution_required", "explicit restored Plan Tree resolution is required");
      assertString(input.reason, "reason");
      const actual = stateBlockDigest(readText(row.plan_target));
      if (actual !== row.state_digest) return fail("plan_tree_drift", "controlled Plan Tree state still differs from the controller digest", { expected: row.state_digest, actual });
      const pending = this.db.prepare("SELECT transaction_id,stage FROM pending_transactions WHERE flow_id=? AND stage IN ('prepared','projected')").all(row.flow_id);
      if (pending.length) return fail("pending_transactions", "resolve drift only after pending transactions are recovered", { pending });
      const planState = parseStateBlock(readText(row.plan_target));
      if (planState.flow_id !== row.flow_id || planState.revision !== row.revision) return fail("plan_state_mismatch", "restored Plan Tree state does not match the controller revision");
      this.transaction(() => this.db.prepare("UPDATE flows SET status=?,frozen=0,drift_report=NULL,updated_at=? WHERE flow_id=?").run(planState.status, nowIso(this.clock), row.flow_id));
      return ok({ action: "drift-resolved", reason: input.reason, flow: publicFlow(this.row(row.flow_id)) });
    } catch (error) { return fail(error.code || "drift_resolution_failed", error.message); }
  }

  auditConsistency(flowId) {
    const row = this.row(flowId);
    if (!row) return fail("flow_not_found", `unknown flow: ${flowId}`);
    try {
      const actual = stateBlockDigest(readText(row.plan_target));
      const pending = this.db.prepare("SELECT transaction_id,stage,old_digest,new_digest FROM pending_transactions WHERE flow_id=? AND stage IN ('prepared','projected')").all(flowId);
      return ok({ consistent: actual === row.state_digest && pending.length === 0 && !row.frozen, expected_digest: row.state_digest, actual_digest: actual, document_digest: fileDigest(row.plan_target), pending, frozen: Boolean(row.frozen), drift_report: row.drift_report ? JSON.parse(row.drift_report) : null });
    } catch (error) { return fail("consistency_check_failed", error.message); }
  }

  projectNativePlan(input) {
    const row = this.row(input.flow_id);
    if (!row) return fail("flow_not_found", `unknown flow: ${input.flow_id}`);
    const policy = this.policyStatus(row);
    if (!policy.ok) return policy;
    if (row.revision !== input.expected_revision) return fail("revision_conflict", "expected_revision is stale", { actual: row.revision });
    if (!/^sha256:[0-9a-f]{64}$/.test(input.request_digest || "")) return fail("invalid_request_digest", "request_digest must be sha256:<64 lowercase hex>");
    if (row.frozen) return fail("flow_frozen", "flow is frozen");
    const route = row.route_json ? JSON.parse(row.route_json) : null;
    const sequence = route?.phase_sequence || PHASE_ORDER;
    const start = sequence.indexOf(row.current_phase);
    const phases = sequence.slice(Math.max(start, 0));
    const steps = [...new Set(phases)].map((phase) => ({ step: PHASE_LABELS[phase], status: phase === row.current_phase ? (row.status === "complete" ? "completed" : "in_progress") : "pending" }));
    const projectionRevision = (this.db.prepare("SELECT COALESCE(MAX(projection_revision),0) AS value FROM native_plan_sync WHERE flow_id=?").get(row.flow_id).value) + 1;
    const plan = { flow_id: row.flow_id, flow_revision: row.revision, projection_revision: projectionRevision, steps };
    const digest = sha256(canonical(plan));
    const projectionId = randomUUID();
    this.transaction(() => this.db.prepare("INSERT INTO native_plan_sync VALUES(?,?,?,?,?,?,?,?,?)").run(projectionId, row.flow_id, row.revision, projectionRevision, JSON.stringify(plan), digest, "projected", nowIso(this.clock), null));
    return ok({ projection_id: projectionId, projection_revision: projectionRevision, digest, plan });
  }

  confirmNativePlan(input) {
    const projection = this.db.prepare("SELECT * FROM native_plan_sync WHERE projection_id=? AND flow_id=?").get(input.projection_id, input.flow_id);
    if (!projection) return fail("projection_not_found", "host-plan projection was not found");
    const row = this.row(input.flow_id);
    const policy = this.policyStatus(row);
    if (!policy.ok) return policy;
    if (row.revision !== input.expected_revision) return fail("revision_conflict", "expected_revision is stale", { actual: row.revision });
    if (!/^sha256:[0-9a-f]{64}$/.test(input.request_digest || "")) return fail("invalid_request_digest", "request_digest must be sha256:<64 lowercase hex>");
    if (row.revision !== projection.flow_revision || input.projection_revision !== projection.projection_revision) return fail("stale_projection", "host-plan projection is stale");
    const actualDigest = sha256(canonical({ flow_id: row.flow_id, flow_revision: row.revision, projection_revision: projection.projection_revision, steps: input.applied_steps }));
    if (actualDigest !== projection.digest) return fail("native_plan_mismatch", "applied host plan does not match projection", { expected_digest: projection.digest, actual_digest: actualDigest });
    this.transaction(() => {
      this.db.prepare("UPDATE native_plan_sync SET status='confirmed',confirmed_at=? WHERE projection_id=?").run(nowIso(this.clock), projection.projection_id);
    });
    return ok({ confirmed: true, advisory: true, digest: actualDigest, flow: publicFlow(this.row(row.flow_id)) });
  }

  markNativePlanUnavailable(input) {
    const row = this.row(input.flow_id);
    if (!row) return fail("flow_not_found", `unknown flow: ${input.flow_id}`);
    const policy = this.policyStatus(row);
    if (!policy.ok) return policy;
    if (row.revision !== input.expected_revision) return fail("revision_conflict", "expected_revision is stale", { actual: row.revision });
    if (!/^sha256:[0-9a-f]{64}$/.test(input.request_digest || "")) return fail("invalid_request_digest", "request_digest must be sha256:<64 lowercase hex>");
    return ok({ available: false, advisory: true, handoff: input.handoff || "Host plan is unavailable; continue from the durable Plan Tree state", flow: publicFlow(row) });
  }

  addEvidence(input) {
    try {
      const row = this.row(input.flow_id);
      if (!row) return fail("flow_not_found", `unknown flow: ${input.flow_id}`);
      const policy = this.policyStatus(row);
      if (!policy.ok) return policy;
      if (row.revision !== input.expected_revision) return fail("revision_conflict", "expected_revision is stale", { actual: row.revision });
      if (!/^sha256:[0-9a-f]{64}$/.test(input.request_digest || "")) throw new Error("request_digest must be sha256:<64 lowercase hex>");
      const evidence = input.evidence;
      assertString(evidence.evidence_id, "evidence_id");
      if (!Array.isArray(evidence.acceptance_ids) || !evidence.acceptance_ids.length) throw new Error("acceptance_ids must not be empty");
      if (!EVIDENCE_RESULTS.includes(evidence.result)) throw new Error(`invalid evidence result: ${evidence.result}`);
      for (const field of ["type", "artifact", "artifact_digest", "command_or_request_id", "observed_at", "producer", "environment"]) assertString(evidence[field], field);
      if (!/^sha256:[0-9a-f]{64}$/.test(evidence.artifact_digest)) throw new Error("artifact_digest must be sha256:<64 lowercase hex>");
      if (Number.isNaN(Date.parse(evidence.observed_at))) throw new Error("observed_at must be ISO-8601");
      const existing = JSON.parse(row.evidence_json || "[]");
      if (existing.some((item) => item.evidence_id === evidence.evidence_id)) return fail("evidence_exists", `evidence already exists: ${evidence.evidence_id}`);
      const fixedPoint = JSON.parse(row.fixed_point_json);
      const record = {
        ...evidence,
        artifact: artifactPath(row.plan_root, evidence.artifact),
        acceptance_ids: [...new Set(evidence.acceptance_ids)],
        supersedes: evidence.supersedes || null,
        expires_at: evidence.expires_at || null,
        legacy_unverified: false,
        delivery_generation: Number(evidence.delivery_generation ?? row.delivery_generation),
        subject_digest: evidence.subject_digest ?? fixedPoint.implementation_digest ?? fixedPoint.spec_digest ?? row.scope_digest
      };
      if (!Number.isInteger(record.delivery_generation) || record.delivery_generation < 1) throw new Error("delivery_generation must be a positive integer");
      if (!/^sha256:[0-9a-f]{64}$/.test(record.subject_digest || "")) throw new Error("subject_digest must be sha256:<64 lowercase hex>");
      const committed = this.commitTransition({ flow_id: row.flow_id, expected_revision: row.revision, request_digest: input.request_digest, event: "evidence-recorded", reason: `record evidence ${record.evidence_id}`, patch: { evidence_records: [...existing, record] } });
      if (!committed.ok) return committed;
      this.syncEvidenceCache(row.flow_id, committed.flow.evidence_records);
      return ok({ evidence_id: evidence.evidence_id, flow: committed.flow });
    } catch (error) { return fail("invalid_evidence", error.message); }
  }

  validateEvidence(input) {
    const row = this.row(input.flow_id);
    if (!row) return fail("flow_not_found", `unknown flow: ${input.flow_id}`);
    const criteria = JSON.parse(row.acceptance_json || "[]");
    const requiredTypes = JSON.parse(row.required_types_json || "[]");
    const records = JSON.parse(row.evidence_json || "[]");
    const superseded = new Set(records.map((item) => item.supersedes).filter(Boolean));
    const fixedPoint = JSON.parse(row.fixed_point_json);
    const activeSubjects = new Set([row.scope_digest, fixedPoint.spec_digest, fixedPoint.implementation_digest, fixedPoint.review_digest].filter(Boolean));
    const valid = [];
    const invalid = [];
    const ignored = [];
    for (const item of records) {
      let reason = null;
      if (superseded.has(item.evidence_id)) { ignored.push({ ...item, reason: "superseded" }); continue; }
      if (item.delivery_generation !== row.delivery_generation) { ignored.push({ ...item, reason: "stale-generation" }); continue; }
      if (!activeSubjects.has(item.subject_digest)) { ignored.push({ ...item, reason: "stale-fixed-point" }); continue; }
      if (item.legacy_unverified) reason = "legacy-unverified";
      else if (item.expires_at && Date.parse(item.expires_at) <= this.clock()) reason = "expired";
      else if (!EVIDENCE_RESULTS.includes(item.result)) reason = "failed-result";
      let artifact = item.artifact;
      try { artifact = artifactPath(row.plan_root, item.artifact); }
      catch (error) { reason ||= error.code || "artifact-path-invalid"; }
      if (!reason && (!existsSync(artifact) || !statSync(artifact).isFile())) reason = "artifact-missing";
      else if (!reason && fileDigest(artifact) !== item.artifact_digest) reason = "artifact-digest-mismatch";
      (reason ? invalid : valid).push({ ...item, artifact, reason });
    }
    const covered = new Set(valid.flatMap((item) => item.acceptance_ids));
    const types = new Set(valid.map((item) => item.type));
    const unmet = criteria.filter((item) => !covered.has(item.acceptance_id)).map((item) => ({ kind: "acceptance", ...item }));
    for (const type of requiredTypes) if (!types.has(type)) unmet.push({ kind: "evidence_type", type });
    return ok({ valid: unmet.length === 0 && invalid.length === 0, unmet_criteria: unmet, invalid_evidence: invalid, ignored_evidence: ignored, evidence: valid });
  }

  syncEvidenceCache(flowId, records) {
    this.db.prepare("DELETE FROM evidence WHERE flow_id=?").run(flowId);
    const insert = this.db.prepare(`INSERT INTO evidence(evidence_id,flow_id,acceptance_ids,type,result,artifact,artifact_digest,command_or_request_id,
      observed_at,producer,environment,supersedes,expires_at,legacy_unverified,delivery_generation,subject_digest) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const evidence of records) insert.run(evidence.evidence_id, flowId, JSON.stringify(evidence.acceptance_ids), evidence.type, evidence.result, evidence.artifact, evidence.artifact_digest, evidence.command_or_request_id, evidence.observed_at, evidence.producer, evidence.environment, evidence.supersedes || null, evidence.expires_at || null, evidence.legacy_unverified ? 1 : 0, evidence.delivery_generation ?? 1, evidence.subject_digest || null);
  }

  syncActionResultCache(flowId, records) {
    this.db.prepare("DELETE FROM external_action_results WHERE flow_id=?").run(flowId);
    const insert = this.db.prepare(`INSERT INTO external_action_results(action_result_id,flow_id,authorization_id,action,target,environment,
      action_request_digest,outcome,observed_at,producer,result_digest,supersedes,delivery_generation,artifact,artifact_digest,command_or_request_id,legacy_unverified)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const result of records || []) insert.run(result.action_result_id, flowId, result.authorization_id, result.action, result.target, result.environment, result.action_request_digest, result.outcome, result.observed_at, result.producer, result.result_digest, result.supersedes || null, result.delivery_generation, result.artifact || null, result.artifact_digest || null, result.command_or_request_id || null, result.legacy_unverified ? 1 : 0);
  }

  rebuildMetricsCache(flowId, history) {
    // Metrics are process-wide aggregates. Rebuilding one flow must never erase counts from unrelated flows.
    this.metric("recovery", "rebuilt-from-plan-tree");
    for (const item of history || []) this.metric("recovered-transition", `${flowId}:${item.event || "unknown"}`);
  }

  requestAuthorization(input) {
    try {
      const row = this.row(input.flow_id);
      if (!row) return fail("flow_not_found", `unknown flow: ${input.flow_id}`);
      const policy = this.policyStatus(row);
      if (!policy.ok) return policy;
      if (row.mode !== "strict") return fail("strict_mode_required", "controlled external actions require a strict flow; explicitly escalate before requesting authorization");
      if (row.revision !== input.expected_revision) return fail("revision_conflict", "expected_revision is stale", { actual: row.revision });
      for (const field of ["action", "target", "environment", "request_digest"]) assertString(input[field], field);
      if (!SENSITIVE_ACTIONS.has(input.action)) return fail("action_not_controlled", `action is not in the controlled external-action set: ${input.action}`);
      if (!/^sha256:[0-9a-f]{64}$/.test(input.request_digest)) return fail("invalid_request_digest", "request_digest must be sha256:<64 lowercase hex>");
      const authorizationId = randomUUID();
      const nonce = randomBytes(18).toString("base64url");
      const challenge = randomBytes(4).toString("hex").toUpperCase();
      const expiresAt = new Date(this.clock() + Math.min(input.ttl_ms || DEFAULT_AUTH_TTL_MS, DEFAULT_AUTH_TTL_MS)).toISOString();
      const controlDigest = input.control_request_digest || requestDigest("request_authorization", input, ["flow_id", "expected_revision", "action", "target", "environment", "request_digest", "ttl_ms"]);
      this.transaction(() => this.db.prepare(`INSERT INTO authorizations
        (authorization_id,flow_id,action,target,environment,request_digest,control_request_digest,expires_at,nonce,challenge_digest,
         confirmed_by,confirmed_at,confirmed_request_digest,consumed_at,consumed_request_digest,created_at,delivery_generation)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        authorizationId, row.flow_id, input.action, input.target, input.environment, input.request_digest, controlDigest, expiresAt,
        nonce, sha256(challenge), null, null, null, null, null, nowIso(this.clock), row.delivery_generation));
      return ok({ authorization_id: authorizationId, expires_at: expiresAt, control_request_digest: controlDigest, confirmation: { mode: input.elicitation_supported ? "elicitation" : "challenge", challenge_code: challenge, prompt: `Authorize ${input.action} on ${input.target} in ${input.environment}` } });
    } catch (error) { return fail("authorization_request_failed", error.message); }
  }

  confirmAuthorization(input) {
    const flow = this.row(input.flow_id);
    if (!flow) return fail("flow_not_found", `unknown flow: ${input.flow_id}`);
    const policy = this.policyStatus(flow);
    if (!policy.ok) return policy;
    if (flow.mode !== "strict") return fail("strict_mode_required", "controlled external actions require a strict flow");
    if (flow.revision !== input.expected_revision) return fail("revision_conflict", "expected_revision is stale", { actual: flow.revision });
    if (!/^sha256:[0-9a-f]{64}$/.test(input.request_digest || "")) return fail("invalid_request_digest", "request_digest must be sha256:<64 lowercase hex>");
    const auth = this.db.prepare("SELECT * FROM authorizations WHERE authorization_id=? AND flow_id=?").get(input.authorization_id, input.flow_id);
    if (!auth) return fail("authorization_not_found", "authorization request not found");
    if (auth.delivery_generation !== flow.delivery_generation) return fail("authorization_stale_generation", "authorization belongs to an older delivery generation");
    if (input.request_digest !== auth.request_digest) return fail("authorization_scope_mismatch", "request_digest does not match authorization scope");
    if (Date.parse(auth.expires_at) <= this.clock()) return fail("authorization_expired", "authorization request expired");
    if (auth.confirmed_at) return fail("authorization_already_confirmed", "authorization was already confirmed");
    if (input.mode === "challenge" && sha256(String(input.challenge_code || "").toUpperCase()) !== auth.challenge_digest) return fail("challenge_mismatch", "challenge code does not match");
    if (input.mode !== "challenge" && input.mode !== "elicitation") return fail("confirmation_required", "confirmation must come from elicitation or challenge mode");
    const confirmedBy = input.confirmed_by || (input.mode === "elicitation" ? "mcp-elicitation" : "user-challenge");
    const controlDigest = input.control_request_digest || requestDigest("confirm_authorization", input, ["flow_id", "expected_revision", "authorization_id", "request_digest", "mode", "confirmed_by"]);
    const confirmedAt = nowIso(this.clock);
    this.transaction(() => this.db.prepare("UPDATE authorizations SET confirmed_by=?,confirmed_at=?,confirmed_request_digest=? WHERE authorization_id=? AND confirmed_at IS NULL").run(confirmedBy, confirmedAt, controlDigest, auth.authorization_id));
    return ok({ authorization_id: auth.authorization_id, confirmed: true, expires_at: auth.expires_at, control_request_digest: controlDigest });
  }

  consumeAuthorization(input) {
    const flow = this.row(input.flow_id);
    if (!flow) return fail("flow_not_found", `unknown flow: ${input.flow_id}`);
    const policy = this.policyStatus(flow);
    if (!policy.ok) return policy;
    if (flow.mode !== "strict") return fail("strict_mode_required", "controlled external actions require a strict flow");
    if (flow.revision !== input.expected_revision) return fail("revision_conflict", "expected_revision is stale", { actual: flow.revision });
    const existingReceipts = JSON.parse(flow.authorization_receipts_json || "[]");
    if (existingReceipts.some((receipt) => receipt.authorization_id === input.authorization_id)) {
      this.transaction(() => this.db.prepare("UPDATE authorizations SET consumed_at=COALESCE(consumed_at,?),consumed_request_digest=COALESCE(consumed_request_digest,?) WHERE authorization_id=?").run(nowIso(this.clock), input.control_request_digest || requestDigest("consume_authorization", input, ["flow_id", "expected_revision", "authorization_id", "action", "target", "environment", "request_digest"]), input.authorization_id));
      return fail("authorization_replayed", "authorization has already been consumed");
    }
    const auth = this.db.prepare("SELECT * FROM authorizations WHERE authorization_id=? AND flow_id=?").get(input.authorization_id, input.flow_id);
    if (!auth) return fail("authorization_not_found", "authorization request not found");
    if (auth.delivery_generation !== flow.delivery_generation) return fail("authorization_stale_generation", "authorization belongs to an older delivery generation");
    if (!auth.confirmed_at) return fail("authorization_unconfirmed", "authorization has not been confirmed");
    if (auth.consumed_at) return fail("authorization_replayed", "authorization has already been consumed");
    if (Date.parse(auth.expires_at) <= this.clock()) return fail("authorization_expired", "authorization expired");
    for (const field of ["action", "target", "environment", "request_digest"]) if (input[field] !== auth[field]) return fail("authorization_scope_mismatch", `${field} does not match authorization scope`);
    const consumedAt = nowIso(this.clock);
    const controlDigest = input.control_request_digest || requestDigest("consume_authorization", input, ["flow_id", "expected_revision", "authorization_id", "action", "target", "environment", "request_digest"]);
    const receipt = { authorization_id: auth.authorization_id, flow_id: auth.flow_id, action: auth.action, target: auth.target, environment: auth.environment, request_digest: auth.request_digest, control_request_digest: controlDigest, confirmed_by: auth.confirmed_by, confirmed_at: auth.confirmed_at, consumed_at: consumedAt, delivery_generation: auth.delivery_generation };
    const receipts = JSON.parse(flow.authorization_receipts_json || "[]");
    const committed = this.commitTransition({ flow_id: flow.flow_id, expected_revision: flow.revision, request_digest: controlDigest, event: "authorization-consumed", reason: `consume authorization ${auth.authorization_id}`, patch: { authorization_receipts: [...receipts, receipt] } });
    if (!committed.ok) return committed;
    let changed;
    this.transaction(() => { changed = this.db.prepare("UPDATE authorizations SET consumed_at=?,consumed_request_digest=? WHERE authorization_id=? AND consumed_at IS NULL").run(consumedAt, controlDigest, auth.authorization_id).changes; });
    if (changed !== 1) return fail("authorization_replayed", "authorization has already been consumed");
    return ok({ receipt, flow: committed.flow });
  }

  recordExternalActionResult(input) {
    try {
      const row = this.row(input.flow_id);
      if (!row) return fail("flow_not_found", `unknown flow: ${input.flow_id}`);
      const policy = this.policyStatus(row);
      if (!policy.ok) return policy;
      if (row.mode !== "strict") return fail("strict_mode_required", "controlled external actions require a strict flow");
      if (row.revision !== input.expected_revision) return fail("revision_conflict", "expected_revision is stale", { actual: row.revision });
      if (!/^sha256:[0-9a-f]{64}$/.test(input.request_digest || "")) return fail("invalid_request_digest", "request_digest must be sha256:<64 lowercase hex>");
      const result = { ...input.result, delivery_generation: input.result.delivery_generation ?? row.delivery_generation, legacy_unverified: false };
      const existing = JSON.parse(row.external_action_results_json || "[]");
      if (existing.some((item) => item.action_result_id === result.action_result_id)) return fail("action_result_exists", `action result already exists: ${result.action_result_id}`);
      if (existing.some((item) => item.authorization_id === result.authorization_id)) return fail("authorization_result_already_recorded", "a consumed authorization can prove exactly one external action attempt");
      const receipts = JSON.parse(row.authorization_receipts_json || "[]");
      const receipt = receipts.find((item) => item.authorization_id === result.authorization_id && item.delivery_generation === row.delivery_generation);
      if (!receipt) return fail("authorization_receipt_missing", "action result requires a consumed authorization receipt");
      for (const [resultField, receiptField] of [["action", "action"], ["target", "target"], ["environment", "environment"], ["action_request_digest", "request_digest"]]) {
        if (result[resultField] !== receipt[receiptField]) return fail("action_result_scope_mismatch", `${resultField} does not match the consumed authorization`);
      }
      for (const field of ["artifact", "artifact_digest", "command_or_request_id"]) assertString(result[field], `action result ${field}`);
      result.artifact = artifactPath(row.plan_root, result.artifact);
      if (!existsSync(result.artifact) || !statSync(result.artifact).isFile()) return fail("action_result_artifact_missing", "external action result artifact does not exist");
      if (fileDigest(result.artifact) !== result.artifact_digest) return fail("action_result_artifact_digest_mismatch", "external action result artifact digest does not match");
      if (result.supersedes) {
        const prior = existing.find((item) => item.action_result_id === result.supersedes);
        if (!prior) return fail("superseded_action_result_missing", "supersedes must reference an existing action result");
        for (const field of ["action", "target", "environment", "action_request_digest"]) if (prior[field] !== result[field]) return fail("superseded_action_result_scope_mismatch", `superseded result has a different ${field}`);
      }
      const normalized = normalizeState({ ...publicFlow(row), external_action_results: [...existing, result] }).external_action_results;
      const committed = this.commitTransition({ flow_id: row.flow_id, expected_revision: row.revision, request_digest: input.request_digest, event: "external-action-observed", reason: input.reason || `record external action result ${result.action_result_id}`, patch: { external_action_results: normalized } });
      if (!committed.ok) return committed;
      return ok({ action_result_id: result.action_result_id, flow: committed.flow });
    } catch (error) { return fail(error.code || "invalid_action_result", error.message); }
  }

  closeFlow(input) {
    const row = this.row(input.flow_id);
    if (!row) return fail("flow_not_found", `unknown flow: ${input.flow_id}`);
    const policy = this.policyStatus(row);
    if (!policy.ok) return policy;
    if (row.revision !== input.expected_revision) return fail("revision_conflict", "expected_revision is stale", { actual: row.revision });
    if (!/^sha256:[0-9a-f]{64}$/.test(input.request_digest || "")) return fail("invalid_request_digest", "request_digest must be sha256:<64 lowercase hex>");
    const consistency = this.auditConsistency(row.flow_id);
    const evidence = this.validateEvidence({ flow_id: row.flow_id });
    const unmet = [...(evidence.ok ? evidence.unmet_criteria : [{ kind: "evidence-validation", error: evidence.error }])];
    if (!consistency.ok || !consistency.consistent) unmet.push({ kind: "consistency", details: consistency });
    const route = row.route_json ? JSON.parse(row.route_json) : null;
    const fixedPoint = JSON.parse(row.fixed_point_json);
    if (MODE_PROFILES[row.mode]?.require_fixed_points) {
      for (const [phase, field] of [["spec", "spec_digest"], ["execute", "implementation_digest"], ["review", "review_digest"]]) {
        if (route?.phase_sequence?.includes(phase) && !fixedPoint[field]) unmet.push({ kind: "fixed-point", phase, field });
      }
    }
    const requiredActions = JSON.parse(row.external_actions_json || "[]");
    const receipts = JSON.parse(row.authorization_receipts_json || "[]");
    const actionResults = JSON.parse(row.external_action_results_json || "[]");
    const supersededResults = new Set(actionResults.map((result) => result.supersedes).filter(Boolean));
    for (const action of requiredActions) {
      const scopedReceipts = action.request_digest ? receipts.filter((receipt) => receipt.action === action.action && receipt.target === action.target && receipt.environment === action.environment && receipt.request_digest === action.request_digest && receipt.consumed_at && receipt.delivery_generation === row.delivery_generation) : [];
      if (!action.request_digest) unmet.push({ kind: "authorization-scope", action, reason: "external action has no request_digest" });
      else if (!scopedReceipts.length) unmet.push({ kind: "authorization", action });
      else {
        const authorizationIds = new Set(scopedReceipts.map((receipt) => receipt.authorization_id));
        const matching = actionResults.filter((result) => !supersededResults.has(result.action_result_id) && authorizationIds.has(result.authorization_id) && result.action === action.action && result.target === action.target && result.environment === action.environment && result.action_request_digest === action.request_digest && result.delivery_generation === row.delivery_generation);
        if (!matching.length) unmet.push({ kind: "external-action-result", action });
        else {
          const successes = matching.filter((result) => result.outcome === "succeeded");
          if (!successes.length) unmet.push({ kind: "external-action-failed", action, results: matching.map((result) => ({ action_result_id: result.action_result_id, outcome: result.outcome })) });
          else if (!successes.some((result) => !result.legacy_unverified && result.artifact && existsSync(result.artifact) && statSync(result.artifact).isFile() && fileDigest(result.artifact) === result.artifact_digest)) {
            unmet.push({ kind: "external-action-result-unverified", action, action_result_ids: successes.map((result) => result.action_result_id) });
          }
        }
      }
    }
    const gates = JSON.parse(row.gate_json || '{"review_findings":[],"terminal_observation":null}');
    const rawObservation = input.terminal_observation || gates.terminal_observation;
    let observation = null;
    try { observation = rawObservation ? { ...rawObservation, artifact: artifactPath(row.plan_root, rawObservation.artifact) } : null; }
    catch (error) { return fail(error.code || "terminal_observation_invalid", error.message); }
    if (!observation) unmet.push({ kind: "terminal-condition", terminal_condition: row.terminal_condition, reason: "terminal_observation evidence is required" });
    else {
      const terminalEvidence = (evidence.evidence || []).find((item) => item.evidence_id === observation.evidence_id && item.artifact === observation.artifact && item.artifact_digest === observation.artifact_digest);
      if (!terminalEvidence) unmet.push({ kind: "terminal-observation-evidence", evidence_id: observation.evidence_id });
    }
    for (const finding of gates.review_findings || []) {
      const activeReviewSubject = fixedPoint.implementation_digest || fixedPoint.spec_digest || row.scope_digest;
      if (finding.delivery_generation !== row.delivery_generation || finding.fixed_point_digest !== activeReviewSubject) {
        continue;
      }
      if (finding.disposition === "open") unmet.push({ kind: "review-finding", finding_id: finding.finding_id, severity: finding.severity });
      if (["P0", "P1"].includes(finding.severity) && (finding.disposition !== "fixed" || !finding.reverified_by)) unmet.push({ kind: "review-reverification", finding_id: finding.finding_id, disposition: finding.disposition });
    }
    if (unmet.length || (evidence.ok && evidence.invalid_evidence.length)) return fail("completion_gate_failed", "flow cannot close until every gate passes", { unmet_criteria: unmet, invalid_evidence: evidence.ok ? evidence.invalid_evidence : [] });
    return this.commitTransition({ flow_id: row.flow_id, expected_revision: row.revision, event: "terminal-verified", reason: input.reason || "terminal condition and all delivery gates verified", request_digest: input.request_digest, patch: { status: "complete", current_phase: "close", next_phase: "none", terminal_observation: observation, resume_point: "Terminal evidence verified; no remaining work" } });
  }

  cancelFlow(input) {
    return this.commitTransition({ ...input, event: "user-cancelled", reason: input.reason || "cancelled by user", patch: { status: "cancelled", next_phase: "none", resume_point: input.resume_point || "Cancelled by user; inspect the last verified evidence before resuming" } });
  }

  getMetrics() {
    const rows = this.db.prepare("SELECT metric,dimension,value FROM metric_aggregates ORDER BY metric,dimension").all();
    return ok({ metrics: rows, privacy: "aggregate counts only; prompts, credentials, paths, and payloads are excluded" });
  }
}
