import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeliveryControl, sha256 } from "../src/core.mjs";
import { POLICY, POLICY_DIGEST, SCHEMA_VERSION } from "../src/constants.mjs";
import { parseStateBlock } from "../src/lib/state-model.mjs";

const roots = [];
const digest = (value) => sha256(value);
const iso = () => new Date().toISOString();

function fixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "delivery-control-v3-"));
  roots.push(root);
  const target = join(root, "current.md");
  writeFileSync(target, "# Current plan\n\nDurable context belongs above the controlled block.\n", "utf8");
  let now = options.now ?? Date.now();
  let faultPoint = null;
  const controller = new DeliveryControl({
    dbPath: join(root, "state.sqlite"),
    clock: () => now,
    fault: (point) => {
      if (point === faultPoint) throw Object.assign(new Error(`injected ${point}`), { code: "injected_crash" });
    }
  });
  const initialized = controller.startOrResumeFlow({
    flow_id: options.flow_id ?? "flow-1",
    expected_revision: 0,
    plan_root: root,
    plan_target: target,
    flow: options.flow ?? "direct",
    mode: options.mode,
    mode_reason: options.mode_reason,
    strict_signals: options.strict_signals ?? [],
    terminal_condition: options.terminal_condition ?? "All acceptance evidence and terminal observation are verified",
    resume_point: options.resume_point ?? "route",
    scope_digest: options.scope_digest ?? digest("scope:v1"),
    acceptance_criteria: options.criteria ?? [{ acceptance_id: "AC-1", description: "The requested outcome works." }],
    required_evidence_types: options.types ?? ["test"],
    external_actions: options.actions ?? []
  });
  assert.equal(initialized.ok, true, JSON.stringify(initialized));
  return {
    root,
    target,
    controller,
    flow: () => controller.inspectFlow(options.flow_id ?? "flow-1").flow,
    advance(ms) { now += ms; },
    crashAt(point) { faultPoint = point; }
  };
}

function route(fx, extra = {}) {
  const current = fx.flow();
  const result = fx.controller.routeFlow({
    flow_id: current.flow_id,
    expected_revision: current.revision,
    chosen_procedure: "policy-driven-delivery",
    why: "The JSON route matches the requested delivery work.",
    confidence: "high",
    ...extra
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.flow;
}

function checkpoint(fx, phase, extra = {}) {
  const current = fx.flow();
  const result = fx.controller.checkpointFlow({
    kind: "phase",
    flow_id: current.flow_id,
    expected_revision: current.revision,
    phase,
    outcome: "completed",
    reason: `Completed ${phase}.`,
    ...extra
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.flow;
}

function directReadyForClose(fx) {
  route(fx);
  checkpoint(fx, "route");
  checkpoint(fx, "execute");
  checkpoint(fx, "review");
  return fx.flow();
}

function terminalEvidence(fx, id = "E-terminal") {
  const artifact = join(fx.root, `${id}.txt`);
  writeFileSync(artifact, `terminal proof ${id}\n`, "utf8");
  const current = fx.flow();
  const result = fx.controller.recordEvidence({
    kind: "delivery",
    flow_id: current.flow_id,
    expected_revision: current.revision,
    evidence: {
      evidence_id: id,
      acceptance_ids: ["AC-1"],
      type: "test",
      result: "verified",
      artifact: `${id}.txt`,
      artifact_digest: digest(readFileSync(artifact)),
      command_or_request_id: `test:${id}`,
      observed_at: iso(),
      producer: "node:test",
      environment: "local"
    }
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return { artifact, evidence: result.flow.evidence_records.find((item) => item.evidence_id === id) };
}

function closeWithTerminalEvidence(fx) {
  directReadyForClose(fx);
  const proof = terminalEvidence(fx);
  const current = fx.flow();
  return fx.controller.closeOrCancelFlow({
    kind: "close",
    flow_id: current.flow_id,
    expected_revision: current.revision,
    reason: "All durable delivery gates are satisfied.",
    terminal_observation: {
      evidence_id: proof.evidence.evidence_id,
      artifact: proof.artifact,
      artifact_digest: proof.evidence.artifact_digest,
      observed_at: proof.evidence.observed_at,
      result: "verified"
    }
  });
}

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

test("initialization pins the canonical JSON policy and projects the controlled state", () => {
  const fx = fixture();
  const flow = fx.flow();
  assert.equal(flow.mode, "standard");
  assert.equal(flow.policy_id, POLICY.policy_id);
  assert.equal(flow.policy_version, POLICY.schema_version);
  assert.equal(flow.policy_digest, POLICY_DIGEST);
  const projected = parseStateBlock(readFileSync(fx.target, "utf8"));
  assert.equal(projected.policy_digest, POLICY_DIGEST);
  assert.equal(projected.current_phase, "route");
  fx.controller.close();
});

test("standard remains light while declared risk auto-escalates to strict", () => {
  const standard = fixture();
  assert.equal(standard.flow().mode, "standard");
  route(standard);
  checkpoint(standard, "route");
  const standardAuth = standard.controller.authorizeExternalAction({ kind: "request", flow_id: "flow-1", expected_revision: standard.flow().revision, action: "deploy", target: "app", environment: "production", request_summary: "release app" });
  assert.equal(standardAuth.error.code, "strict_mode_required");
  standard.controller.close();

  const strict = fixture({ strict_signals: ["multi-agent"] });
  assert.equal(strict.flow().mode, "strict");
  route(strict);
  strict.controller.transaction(() => strict.controller.acquireLease("flow-1", "other-writer", 25));
  const blocked = strict.controller.checkpointFlow({ kind: "phase", flow_id: "flow-1", expected_revision: 1, phase: "route", outcome: "completed", reason: "route" });
  assert.equal(blocked.error.code, "lease_conflict");
  strict.advance(26);
  const resumed = strict.controller.checkpointFlow({ kind: "phase", flow_id: "flow-1", expected_revision: 1, phase: "route", outcome: "completed", reason: "route", artifact_digest: undefined });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  strict.controller.close();

  const root = mkdtempSync(join(tmpdir(), "delivery-control-v3-risk-"));
  roots.push(root);
  const target = join(root, "current.md");
  writeFileSync(target, "# Current\n");
  const controller = new DeliveryControl({ dbPath: join(root, "state.sqlite") });
  const rejected = controller.startOrResumeFlow({
    flow_id: "must-be-strict", expected_revision: 0, plan_root: root, plan_target: target, flow: "direct", mode: "standard",
    terminal_condition: "done", resume_point: "route", external_actions: [{ action: "deploy", target: "app", environment: "production", request_summary: "release app" }]
  });
  assert.equal(rejected.error.code, "strict_mode_required");
  controller.close();
});

test("CAS rejects stale writes and independent flows remain isolated", () => {
  const fx = fixture();
  const secondTarget = join(fx.root, "second.md");
  writeFileSync(secondTarget, "# Second\n");
  const second = fx.controller.startOrResumeFlow({
    flow_id: "flow-2", expected_revision: 0, plan_root: fx.root, plan_target: secondTarget, flow: "bug",
    terminal_condition: "fixed", resume_point: "route"
  });
  assert.equal(second.ok, true, JSON.stringify(second));
  const sameTarget = fx.controller.startOrResumeFlow({
    flow_id: "flow-3", expected_revision: 0, plan_root: fx.root, plan_target: fx.target, flow: "bug",
    terminal_condition: "fixed", resume_point: "route"
  });
  assert.equal(sameTarget.error.code, "plan_target_bound");
  const first = fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 0, event: "advance", reason: "move", patch: { current_phase: "execute", next_phase: "review" } });
  assert.equal(first.ok, true, JSON.stringify(first));
  const stale = fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 0, event: "advance", reason: "stale", patch: { current_phase: "review", next_phase: "close" } });
  assert.equal(stale.error.code, "revision_conflict");
  assert.equal(fx.controller.inspectFlow("flow-2").flow.revision, 0);
  fx.controller.close();
});

test("ordinary Plan Tree prose changes do not freeze a flow, but controlled-state drift does", () => {
  const fx = fixture();
  route(fx);
  writeFileSync(fx.target, `${readFileSync(fx.target, "utf8")}\nHuman note outside the state block.\n`, "utf8");
  checkpoint(fx, "route");
  assert.match(readFileSync(fx.target, "utf8"), /Human note outside the state block/);

  const text = readFileSync(fx.target, "utf8");
  assert.match(text, /"resume_point": "Continue execute"/);
  writeFileSync(fx.target, text.replace('"resume_point": "Continue execute"', '"resume_point": "changed outside controller"'));
  const result = fx.controller.checkpointFlow({ kind: "phase", flow_id: "flow-1", expected_revision: fx.flow().revision, phase: "execute", outcome: "completed", reason: "execute" });
  assert.equal(result.error.code, "plan_tree_drift");
  assert.equal(fx.flow().frozen, true);
  fx.controller.close();
});

test("evidence paths are limited to plan_root and valid local artifacts retain their digest", () => {
  const fx = fixture();
  const outside = join(fx.root, "..", "outside-proof.txt");
  writeFileSync(outside, "outside\n");
  const rejected = fx.controller.recordEvidence({
    kind: "delivery", flow_id: "flow-1", expected_revision: 0,
    evidence: { evidence_id: "E-escape", acceptance_ids: ["AC-1"], type: "test", result: "verified", artifact: "../outside-proof.txt", artifact_digest: digest(readFileSync(outside)), command_or_request_id: "escape", observed_at: iso(), producer: "test", environment: "local" }
  });
  assert.equal(rejected.error.code, "invalid_evidence");
  assert.match(rejected.error.message, /traversal|inside plan_root/i);
  const artifact = join(fx.root, "proof file.txt");
  writeFileSync(artifact, "inside\n");
  const accepted = fx.controller.recordEvidence({
    kind: "delivery", flow_id: "flow-1", expected_revision: 0,
    evidence: { evidence_id: "E-inside", acceptance_ids: ["AC-1"], type: "test", result: "verified", artifact: "proof file.txt", artifact_digest: digest(readFileSync(artifact)), command_or_request_id: "inside", observed_at: iso(), producer: "test", environment: "local" }
  });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(accepted.flow.evidence_records[0].artifact, artifact);
  fx.controller.close();
});

test("policy upgrades require an explicit migration rather than silently reinterpreting a flow", () => {
  const fx = fixture();
  fx.controller.db.prepare("UPDATE flows SET policy_digest=? WHERE flow_id=?").run(digest("different-policy"), "flow-1");
  const blocked = fx.controller.routeFlow({ flow_id: "flow-1", expected_revision: 0, chosen_procedure: "route", why: "route", confidence: "high" });
  assert.equal(blocked.error.code, "policy_migration_required");
  const migrated = fx.controller.checkpointFlow({ kind: "migrate-policy", flow_id: "flow-1", expected_revision: 0, accept_current_policy: true, reason: "User accepted the reviewed policy upgrade." });
  assert.equal(migrated.ok, true, JSON.stringify(migrated));
  assert.equal(migrated.flow.policy_digest, POLICY_DIGEST);
  fx.controller.close();
});

test("a host plan is advisory: a standard flow closes with evidence even when no host plan exists", () => {
  const fx = fixture();
  const closed = closeWithTerminalEvidence(fx);
  assert.equal(closed.ok, true, JSON.stringify(closed));
  assert.equal(closed.flow.status, "complete");
  assert.equal(closed.flow.plan_sync, "not-requested");
  fx.controller.close();
});

test("strict flows require fixed-point evidence while standard flows do not", () => {
  const fx = fixture({ strict_signals: ["release"] });
  route(fx);
  checkpoint(fx, "route");
  const blocked = fx.controller.checkpointFlow({ kind: "phase", flow_id: "flow-1", expected_revision: fx.flow().revision, phase: "execute", outcome: "completed", reason: "execute" });
  assert.equal(blocked.error.code, "fixed_point_digest_required");
  const fixed = fx.controller.checkpointFlow({ kind: "phase", flow_id: "flow-1", expected_revision: fx.flow().revision, phase: "execute", outcome: "completed", reason: "execute", artifact_digest: digest("implementation-fixed-point") });
  assert.equal(fixed.ok, true, JSON.stringify(fixed));
  fx.controller.close();
});

test("native-plan compatibility remains advisory and does not advance the flow revision", () => {
  const fx = fixture();
  const projected = fx.controller.projectNativePlan({ flow_id: "flow-1", expected_revision: 0, request_digest: digest("project") });
  assert.equal(projected.ok, true, JSON.stringify(projected));
  const confirmed = fx.controller.confirmNativePlan({ flow_id: "flow-1", expected_revision: 0, request_digest: digest("confirm"), projection_id: projected.projection_id, projection_revision: projected.projection_revision, applied_steps: projected.plan.steps });
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
  assert.equal(confirmed.advisory, true);
  assert.equal(fx.flow().revision, 0);
  fx.controller.close();
});

test("authorization is exact, short-lived, and single-use", () => {
  const fx = fixture({
    actions: [{ action: "deploy", target: "app", environment: "production", request_summary: "release app" }]
  });
  assert.equal(fx.flow().mode, "strict");
  const request = fx.controller.authorizeExternalAction({ kind: "request", flow_id: "flow-1", expected_revision: 0, action: "deploy", target: "app", environment: "production", request_summary: "release app" });
  assert.equal(request.ok, true, JSON.stringify(request));
  const wrong = fx.controller.authorizeExternalAction({ kind: "confirm", flow_id: "flow-1", expected_revision: 0, authorization_id: request.authorization_id, action: "deploy", target: "app", environment: "production", request_summary: "different request", confirmation_mode: "challenge", challenge_code: request.confirmation.challenge_code });
  assert.equal(wrong.error.code, "authorization_scope_mismatch");
  const confirmed = fx.controller.authorizeExternalAction({ kind: "confirm", flow_id: "flow-1", expected_revision: 0, authorization_id: request.authorization_id, action: "deploy", target: "app", environment: "production", request_summary: "release app", confirmation_mode: "challenge", challenge_code: request.confirmation.challenge_code });
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
  const consumed = fx.controller.authorizeExternalAction({ kind: "consume", flow_id: "flow-1", expected_revision: 0, authorization_id: request.authorization_id, action: "deploy", target: "app", environment: "production", request_summary: "release app" });
  assert.equal(consumed.ok, true, JSON.stringify(consumed));
  const replay = fx.controller.authorizeExternalAction({ kind: "consume", flow_id: "flow-1", expected_revision: 1, authorization_id: request.authorization_id, action: "deploy", target: "app", environment: "production", request_summary: "release app" });
  assert.equal(replay.error.code, "authorization_replayed");
  fx.controller.close();
});

test("initialization and transition journals recover at each injected crash boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "delivery-control-v3-crash-"));
  roots.push(root);
  const target = join(root, "current.md");
  const dbPath = join(root, "state.sqlite");
  writeFileSync(target, "# Current\n");
  const initialCrash = new DeliveryControl({ dbPath, fault: (point) => { if (point === "after_initialize_prepare") throw Object.assign(new Error("crash"), { code: "injected_crash" }); } });
  const init = initialCrash.startOrResumeFlow({ flow_id: "crash-flow", expected_revision: 0, plan_root: root, plan_target: target, flow: "direct", terminal_condition: "done", resume_point: "route" });
  assert.equal(init.error.code, "injected_crash");
  const overlappingStart = initialCrash.startOrResumeFlow({ flow_id: "other-flow", expected_revision: 0, plan_root: root, plan_target: target, flow: "direct", terminal_condition: "done", resume_point: "route" });
  assert.equal(overlappingStart.error.code, "flow_initializing");
  initialCrash.close();
  const recovery = new DeliveryControl({ dbPath });
  const rolledBack = recovery.recoverFlow({ flow_id: "crash-flow", expected_revision: 0, request_digest: digest("recover-init"), plan_root: root, plan_target: target });
  assert.equal(rolledBack.ok, true, JSON.stringify(rolledBack));
  assert.equal(rolledBack.action, "rolled-back-initialization");
  const started = recovery.startOrResumeFlow({ flow_id: "crash-flow", expected_revision: 0, plan_root: root, plan_target: target, flow: "direct", terminal_condition: "done", resume_point: "route" });
  assert.equal(started.ok, true, JSON.stringify(started));
  recovery.close();

  const projectedRoot = mkdtempSync(join(tmpdir(), "delivery-control-v3-init-projected-"));
  roots.push(projectedRoot);
  const projectedTarget = join(projectedRoot, "current.md");
  const projectedDb = join(projectedRoot, "state.sqlite");
  writeFileSync(projectedTarget, "# Current\n");
  const projectedCrash = new DeliveryControl({ dbPath: projectedDb, fault: (point) => { if (point === "after_initialize_project") throw Object.assign(new Error("crash"), { code: "injected_crash" }); } });
  const projectedStart = projectedCrash.startOrResumeFlow({ flow_id: "projected-init", expected_revision: 0, plan_root: projectedRoot, plan_target: projectedTarget, flow: "direct", terminal_condition: "done", resume_point: "route" });
  assert.equal(projectedStart.error.code, "injected_crash");
  projectedCrash.close();
  const projectedRecovery = new DeliveryControl({ dbPath: projectedDb });
  const completedInit = projectedRecovery.recoverFlow({ flow_id: "projected-init", expected_revision: 0, request_digest: digest("recover-projected-init"), plan_root: projectedRoot, plan_target: projectedTarget });
  assert.equal(completedInit.ok, true, JSON.stringify(completedInit));
  assert.equal(completedInit.action, "completed-initialization-recovery");
  assert.equal(completedInit.flow.revision, 0);
  projectedRecovery.close();

  const fx = fixture();
  route(fx);
  fx.crashAt("after_project");
  const crash = fx.controller.checkpointFlow({ kind: "phase", flow_id: "flow-1", expected_revision: 1, phase: "route", outcome: "completed", reason: "route" });
  assert.equal(crash.error.code, "injected_crash");
  fx.crashAt(null);
  fx.advance(30_001);
  const reconciled = fx.controller.auditOrRecoverFlow({ kind: "recover", flow_id: "flow-1", expected_revision: 1, request_summary: "recover after projection" });
  assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
  assert.equal(reconciled.flow.current_phase, "execute");
  fx.controller.close();
});

test("a missing SQLite index is rebuilt from the Plan Tree, while a v5 database migrates to v6", () => {
  const fx = fixture();
  fx.controller.close();
  rmSync(join(fx.root, "state.sqlite"), { force: true });
  const rebuilt = new DeliveryControl({ dbPath: join(fx.root, "state.sqlite") });
  const recovered = rebuilt.recoverFlow({ flow_id: "flow-1", expected_revision: 0, request_digest: digest("rebuild"), plan_root: fx.root, plan_target: fx.target });
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(recovered.action, "rebuilt-from-plan-tree");
  rebuilt.close();

  const schemaPath = join(fx.root, "v5.sqlite");
  const old = new DatabaseSync(schemaPath);
  old.exec("CREATE TABLE schema_meta (version INTEGER NOT NULL); INSERT INTO schema_meta VALUES(5);");
  old.close();
  const migrated = new DeliveryControl({ dbPath: schemaPath });
  assert.equal(migrated.db.prepare("SELECT version FROM schema_meta").get().version, SCHEMA_VERSION);
  const columns = migrated.db.prepare("PRAGMA table_info(flows)").all().map((item) => item.name);
  for (const column of ["state_digest", "mode", "policy_id", "policy_digest"]) assert.ok(columns.includes(column));
  migrated.close();
});

test("close reports structured unmet criteria rather than accepting agent assertions", () => {
  const fx = fixture();
  route(fx);
  checkpoint(fx, "route");
  checkpoint(fx, "execute");
  checkpoint(fx, "review");
  const blocked = fx.controller.closeOrCancelFlow({ kind: "close", flow_id: "flow-1", expected_revision: fx.flow().revision, reason: "agent says it is done" });
  assert.equal(blocked.error.code, "completion_gate_failed");
  assert.ok(blocked.error.unmet_criteria.some((item) => item.kind === "acceptance"));
  assert.ok(blocked.error.unmet_criteria.some((item) => item.kind === "terminal-condition"));
  fx.controller.close();
});
