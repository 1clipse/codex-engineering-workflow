import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { DeliveryControl, sha256 } from "../src/core.mjs";

const roots = [];
const workerPath = fileURLToPath(new URL("./helpers/flow-worker.mjs", import.meta.url));
const runWorker = (args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [workerPath, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("close", (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
});
const fixture = (options = {}) => {
  const root = mkdtempSync(join(tmpdir(), "delivery-control-"));
  roots.push(root);
  const target = join(root, "current.md");
  writeFileSync(target, "# Current plan\n", "utf8");
  let clock = options.now ?? Date.now();
  const controller = new DeliveryControl({ dbPath: join(root, "state.sqlite"), clock: () => clock, fault: options.fault });
  const initialized = controller.initializeFlow({
    flow_id: options.flow_id || "flow-1", plan_root: root, plan_target: target, flow: "main",
    expected_revision: 0, request_digest: sha256(`initialize:${options.flow_id || "flow-1"}`),
    terminal_condition: "All acceptance evidence is verified", resume_point: "route", scope_digest: options.scope_digest ?? sha256("scope:v1"),
    acceptance_criteria: options.criteria ?? [{ acceptance_id: "AC-1", description: "works" }],
    required_evidence_types: options.types ?? ["test"], external_actions: options.actions ?? []
  });
  assert.equal(initialized.ok, true, JSON.stringify(initialized));
  return { root, target, controller, advance(ms) { clock += ms; } };
};

test.after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

test("CAS rejects stale transition and isolates flows", () => {
  const fx = fixture();
  const secondTarget = join(fx.root, "second.md");
  writeFileSync(secondTarget, "# Second\n");
  const second = fx.controller.initializeFlow({ flow_id: "flow-2", expected_revision: 0, request_digest: sha256("initialize:flow-2"), plan_root: fx.root, plan_target: secondTarget, flow: "bug", terminal_condition: "fixed", resume_point: "route" });
  assert.equal(second.ok, true);
  const moved = fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 0, event: "advance", reason: "ready", patch: { current_phase: "spec", next_phase: "execute" } });
  assert.equal(moved.ok, true);
  const stale = fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 0, event: "advance", reason: "stale", patch: { current_phase: "execute" } });
  assert.equal(stale.error.code, "revision_conflict");
  assert.equal(fx.controller.inspectFlow("flow-2").flow.revision, 0);
  fx.controller.close();
});

test("lease conflict fails closed and expired lease can be taken over", () => {
  const fx = fixture();
  fx.controller.transaction(() => fx.controller.acquireLease("flow-1", "writer-a", 10));
  const conflict = fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 0, lease_owner: "writer-b", event: "advance", reason: "conflict", patch: { current_phase: "spec" } });
  assert.equal(conflict.error.code, "lease_conflict");
  fx.advance(11);
  const takeover = fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 0, lease_owner: "writer-b", event: "advance", reason: "take over", patch: { current_phase: "spec" } });
  assert.equal(takeover.ok, true, JSON.stringify(takeover));
  fx.controller.close();
});

test("recovery respects active lease and proceeds after expiry", () => {
  const fx = fixture();
  fx.controller.transaction(() => fx.controller.acquireLease("flow-1", "writer-a", 10));
  const blocked = fx.controller.recoverFlow({ flow_id: "flow-1", expected_revision: 0, request_digest: sha256("recover-active"), lease_owner: "recovery" });
  assert.equal(blocked.error.code, "lease_conflict");
  fx.advance(11);
  const recovered = fx.controller.recoverFlow({ flow_id: "flow-1", expected_revision: 0, request_digest: sha256("recover-expired"), lease_owner: "recovery" });
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  fx.controller.close();
});

test("prepared crash rolls back when Plan Tree is unchanged", () => {
  let crash = true;
  const fx = fixture({ fault: (point) => { if (crash && point === "after_prepare") throw Object.assign(new Error("crash"), { code: "injected_crash" }); } });
  const result = fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 0, event: "advance", reason: "crash", patch: { current_phase: "spec" } });
  assert.equal(result.error.code, "injected_crash");
  crash = false;
  fx.advance(30_001);
  const recovered = fx.controller.recoverFlow({ flow_id: "flow-1", expected_revision: 0, request_digest: sha256("recover") });
  assert.equal(recovered.action, "reconciled");
  assert.equal(recovered.flow.revision, 0);
  fx.controller.close();
});

test("projected crash completes transaction from journal", () => {
  let crash = true;
  const fx = fixture({ fault: (point) => { if (crash && point === "after_project") throw Object.assign(new Error("crash"), { code: "injected_crash" }); } });
  const result = fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 0, event: "advance", reason: "crash", patch: { current_phase: "spec", next_phase: "execute" } });
  assert.equal(result.error.code, "injected_crash");
  crash = false;
  fx.advance(30_001);
  const recovered = fx.controller.recoverFlow({ flow_id: "flow-1", expected_revision: 0, request_digest: sha256("recover") });
  assert.equal(recovered.action, "reconciled");
  assert.equal(recovered.flow.revision, 1);
  assert.equal(recovered.flow.current_phase, "spec");
  fx.controller.close();
});

test("independent processes serialize competing flow writes", async () => {
  const fx = fixture();
  const dbPath = join(fx.root, "state.sqlite");
  const workers = await Promise.all([runWorker(["compete-a", dbPath, "flow-1"]), runWorker(["compete-b", dbPath, "flow-1"])]);
  const results = workers.map((worker) => JSON.parse(worker.stdout));
  assert.equal(results.filter((result) => result.ok).length, 1, JSON.stringify(results));
  assert.equal(results.filter((result) => !result.ok && ["revision_conflict", "lease_conflict"].includes(result.error.code)).length, 1, JSON.stringify(results));
  assert.equal(fx.controller.inspectFlow("flow-1").flow.revision, 1);
  fx.controller.close();
});

test("a real process exit after projection is recovered by a new controller", async () => {
  const fx = fixture();
  const dbPath = join(fx.root, "state.sqlite");
  fx.controller.close();
  const crashed = await runWorker(["crash-after-project", dbPath, "flow-1"]);
  assert.equal(crashed.code, 86, crashed.stderr);
  const recovery = new DeliveryControl({ dbPath });
  const recovered = recovery.recoverFlow({ flow_id: "flow-1", expected_revision: 0, request_digest: sha256("cross-process-recover"), lease_ms: 10 });
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(recovered.flow.revision, 1);
  assert.equal(recovered.actions[0].action, "completed-projected-transaction");
  recovery.close();
});

test("Plan Tree and relative evidence support spaces and non-ASCII paths", () => {
  const base = mkdtempSync(join(tmpdir(), "delivery-control-path-"));
  roots.push(base);
  const root = join(base, "delivery control \u8def\u5f84");
  mkdirSync(root);
  const target = join(root, "current plan.md");
  const artifact = join(root, "proof file.txt");
  writeFileSync(target, "# Portable plan\n");
  writeFileSync(artifact, "portable proof\n");
  const controller = new DeliveryControl({ dbPath: join(root, "state file.sqlite") });
  const initialized = controller.initializeFlow({ flow_id: "portable-flow", expected_revision: 0, request_digest: sha256("portable-init"), plan_root: root, plan_target: target, flow: "main", terminal_condition: "Portable evidence verified", resume_point: "route", scope_digest: sha256("portable-scope"), acceptance_criteria: [{ acceptance_id: "AC-portable", description: "portable" }], required_evidence_types: ["test"] });
  assert.equal(initialized.ok, true, JSON.stringify(initialized));
  const recorded = controller.addEvidence({ flow_id: "portable-flow", expected_revision: 0, request_digest: sha256("portable-evidence"), evidence: { evidence_id: "E-portable", acceptance_ids: ["AC-portable"], type: "test", result: "verified", artifact: "proof file.txt", artifact_digest: sha256(readFileSync(artifact)), command_or_request_id: "portable", observed_at: new Date().toISOString(), producer: "test", environment: "local" } });
  assert.equal(recorded.ok, true, JSON.stringify(recorded));
  assert.equal(controller.validateEvidence({ flow_id: "portable-flow" }).valid, true);
  controller.close();
});

test("external Plan Tree edit freezes the flow", () => {
  const fx = fixture();
  writeFileSync(fx.target, `${readFileSync(fx.target, "utf8")}\nexternal edit\n`);
  const result = fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 0, event: "advance", reason: "move", patch: { current_phase: "spec" } });
  assert.equal(result.error.code, "plan_tree_drift");
  assert.equal(fx.controller.inspectFlow("flow-1").flow.frozen, true);
  fx.controller.close();
});

test("explicit restored Plan Tree resolution clears a freeze", () => {
  const fx = fixture();
  const original = readFileSync(fx.target, "utf8");
  writeFileSync(fx.target, `${original}\nexternal edit\n`);
  const drift = fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 0, event: "advance", reason: "move", patch: { current_phase: "spec" } });
  assert.equal(drift.error.code, "plan_tree_drift");
  writeFileSync(fx.target, original);
  const resolved = fx.controller.resolveDrift({ flow_id: "flow-1", expected_revision: 0, request_digest: sha256("resolve-restored"), resolution: "accept-restored-plan-tree", reason: "User confirmed the restored Plan Tree digest" });
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
  assert.equal(resolved.flow.frozen, false);
  assert.equal(resolved.flow.status, "active");
  const moved = fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 0, event: "advance", reason: "resume", patch: { current_phase: "spec" } });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  fx.controller.close();
});

test("database can rebuild from Plan Tree", () => {
  const fx = fixture();
  fx.controller.close();
  const rebuiltDb = join(fx.root, "rebuilt.sqlite");
  const rebuilt = new DeliveryControl({ dbPath: rebuiltDb });
  const result = rebuilt.recoverFlow({ flow_id: "flow-1", expected_revision: 0, request_digest: sha256("rebuild"), plan_root: fx.root, plan_target: fx.target });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.action, "rebuilt-from-plan-tree");
  rebuilt.close();
});

test("native Plan confirmation rejects stale and mismatched projections", () => {
  const fx = fixture();
  const projection = fx.controller.projectNativePlan({ flow_id: "flow-1", expected_revision: 0, request_digest: sha256("project") });
  assert.equal(projection.ok, true);
  const mismatch = fx.controller.confirmNativePlan({ flow_id: "flow-1", expected_revision: 0, request_digest: sha256("confirm-wrong"), projection_id: projection.projection_id, projection_revision: projection.projection_revision, applied_steps: [{ step: "wrong", status: "in_progress" }] });
  assert.equal(mismatch.error.code, "native_plan_mismatch");
  const moved = fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 0, event: "advance", reason: "advance", patch: { current_phase: "spec" } });
  assert.equal(moved.ok, true);
  const stale = fx.controller.confirmNativePlan({ flow_id: "flow-1", expected_revision: 1, request_digest: sha256("confirm-stale"), projection_id: projection.projection_id, projection_revision: projection.projection_revision, applied_steps: projection.plan.steps });
  assert.equal(stale.error.code, "stale_projection");
  fx.controller.close();
});

test("evidence gate checks acceptance coverage and artifact digest", () => {
  const fx = fixture();
  const artifact = join(fx.root, "test.txt");
  writeFileSync(artifact, "pass");
  const missing = fx.controller.validateEvidence({ flow_id: "flow-1" });
  assert.equal(missing.valid, false);
  const recorded = fx.controller.addEvidence({ flow_id: "flow-1", expected_revision: 0, request_digest: sha256("evidence:E-1"), evidence: {
    evidence_id: "E-1", acceptance_ids: ["AC-1"], type: "test", result: "passed", artifact,
    artifact_digest: sha256(readFileSync(artifact)), command_or_request_id: "node-test", observed_at: new Date().toISOString(), producer: "test", environment: "local"
  }});
  assert.equal(recorded.ok, true, JSON.stringify(recorded));
  assert.equal(fx.controller.validateEvidence({ flow_id: "flow-1" }).valid, true);
  writeFileSync(artifact, "changed");
  const invalid = fx.controller.validateEvidence({ flow_id: "flow-1" });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.invalid_evidence[0].reason, "artifact-digest-mismatch");
  fx.controller.close();
});

test("authorization is scoped, expires, and cannot be replayed", () => {
  const fx = fixture();
  const requestDigest = sha256("push-request");
  const requested = fx.controller.requestAuthorization({ flow_id: "flow-1", expected_revision: 0, action: "push", target: "origin/main", environment: "github", request_digest: requestDigest, elicitation_supported: false });
  assert.equal(requested.ok, true);
  assert.notEqual(requested.control_request_digest, requestDigest);
  assert.equal(fx.controller.confirmAuthorization({ flow_id: "flow-1", expected_revision: 0, request_digest: requestDigest, authorization_id: requested.authorization_id, mode: "challenge", challenge_code: "BAD" }).error.code, "challenge_mismatch");
  const confirmed = fx.controller.confirmAuthorization({ flow_id: "flow-1", expected_revision: 0, request_digest: requestDigest, authorization_id: requested.authorization_id, mode: "challenge", challenge_code: requested.confirmation.challenge_code });
  assert.equal(confirmed.ok, true);
  assert.notEqual(confirmed.control_request_digest, requestDigest);
  const mismatch = fx.controller.consumeAuthorization({ flow_id: "flow-1", expected_revision: 0, authorization_id: requested.authorization_id, action: "merge", target: "origin/main", environment: "github", request_digest: requestDigest });
  assert.equal(mismatch.error.code, "authorization_scope_mismatch");
  const consumed = fx.controller.consumeAuthorization({ flow_id: "flow-1", expected_revision: 0, authorization_id: requested.authorization_id, action: "push", target: "origin/main", environment: "github", request_digest: requestDigest });
  assert.equal(consumed.ok, true);
  assert.notEqual(consumed.receipt.control_request_digest, requestDigest);
  const replay = fx.controller.consumeAuthorization({ flow_id: "flow-1", expected_revision: 1, authorization_id: requested.authorization_id, action: "push", target: "origin/main", environment: "github", request_digest: requestDigest });
  assert.equal(replay.error.code, "authorization_replayed");
  const expiring = fx.controller.requestAuthorization({ flow_id: "flow-1", expected_revision: 1, action: "deploy", target: "app", environment: "prod", request_digest: sha256("deploy"), ttl_ms: 10, elicitation_supported: false });
  fx.advance(11);
  assert.equal(fx.controller.confirmAuthorization({ flow_id: "flow-1", expected_revision: 1, request_digest: sha256("deploy"), authorization_id: expiring.authorization_id, mode: "challenge", challenge_code: expiring.confirmation.challenge_code }).error.code, "authorization_expired");
  fx.controller.close();
});

test("scope revision invalidates outstanding external-action authorization", () => {
  const fx = fixture();
  const actionDigest = sha256("generation-one-deploy");
  const requested = fx.controller.requestAuthorization({ flow_id: "flow-1", expected_revision: 0, action: "deploy", target: "app", environment: "prod", request_digest: actionDigest, elicitation_supported: false });
  assert.equal(requested.ok, true);
  const revised = fx.controller.reviseScope({ flow_id: "flow-1", expected_revision: 0, request_digest: sha256("authorization-scope-revision"), scope_digest: sha256("scope:v2"), reason: "deployment scope changed" });
  assert.equal(revised.ok, true, JSON.stringify(revised));
  const stale = fx.controller.confirmAuthorization({ flow_id: "flow-1", expected_revision: 1, request_digest: actionDigest, authorization_id: requested.authorization_id, mode: "challenge", challenge_code: requested.confirmation.challenge_code });
  assert.equal(stale.error.code, "authorization_stale_generation");
  fx.controller.close();
});

test("close gate requires evidence, terminal observation, and native Plan status", () => {
  const fx = fixture();
  const blocked = fx.controller.closeFlow({ flow_id: "flow-1", expected_revision: 0, request_digest: sha256("close-blocked"), terminal_observed: false });
  assert.equal(blocked.error.code, "completion_gate_failed");
  const artifact = join(fx.root, "proof.txt");
  writeFileSync(artifact, "verified");
  assert.equal(fx.controller.addEvidence({ flow_id: "flow-1", expected_revision: 0, request_digest: sha256("evidence:E-1"), evidence: {
    evidence_id: "E-1", acceptance_ids: ["AC-1"], type: "test", result: "verified", artifact,
    artifact_digest: sha256(readFileSync(artifact)), command_or_request_id: "test", observed_at: new Date().toISOString(), producer: "test", environment: "local"
  }}).ok, true);
  const projection = fx.controller.projectNativePlan({ flow_id: "flow-1", expected_revision: 1, request_digest: sha256("project") });
  assert.equal(fx.controller.confirmNativePlan({ flow_id: "flow-1", expected_revision: 1, request_digest: sha256("confirm"), projection_id: projection.projection_id, projection_revision: projection.projection_revision, applied_steps: projection.plan.steps }).ok, true);
  assert.equal(fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 2, request_digest: sha256("spec"), event: "advance", reason: "spec completed", patch: { current_phase: "spec", next_phase: "execute" } }).ok, true);
  assert.equal(fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 3, request_digest: sha256("execute"), event: "advance", reason: "execute completed", patch: { current_phase: "execute", next_phase: "review" } }).ok, true);
  const reviewed = fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 4, request_digest: sha256("review"), event: "advance", reason: "review completed", patch: { current_phase: "review", next_phase: "close" } });
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed));
  const closed = fx.controller.closeFlow({ flow_id: "flow-1", expected_revision: 5, request_digest: sha256("close"), terminal_observation: { evidence_id: "E-1", artifact, artifact_digest: sha256(readFileSync(artifact)), observed_at: new Date().toISOString(), result: "verified" } });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  assert.equal(closed.flow.status, "complete");
  fx.controller.close();
});

test("state machine rejects illegal phase and event transitions", () => {
  const fx = fixture();
  const review = fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 0, request_digest: sha256("to-review"), event: "advance", reason: "review", patch: { current_phase: "review", next_phase: "close" } });
  assert.equal(review.error.code, "execute_required");
  const spec = fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 0, request_digest: sha256("spec"), event: "advance", reason: "spec", patch: { current_phase: "spec", next_phase: "execute" } });
  assert.equal(spec.ok, true);
  const illegal = fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 1, request_digest: sha256("illegal"), event: "advance", reason: "bad", patch: { current_phase: "close" } });
  assert.equal(illegal.error.code, "illegal_phase_transition");
  const eventRule = fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 1, request_digest: sha256("event"), event: "spec-not-ready", reason: "bad", patch: { current_phase: "execute" } });
  assert.equal(eventRule.error.code, "event_rule_violation");
  fx.controller.close();
});

test("new flows cannot bypass spec before execute", () => {
  const fx = fixture();
  const bypass = fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 0, request_digest: sha256("bypass-spec"), event: "advance", reason: "skip spec", patch: { current_phase: "execute", next_phase: "review" } });
  assert.equal(bypass.error.code, "spec_required");
  const route = fx.controller.selectRoute({ flow_id: "flow-1", expected_revision: 0, request_digest: sha256("route-for-skip"), chosen_procedure: "implement", why: "test route", confidence: "high" });
  assert.equal(route.ok, true, JSON.stringify(route));
  const undeclared = fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 1, request_digest: sha256("undeclared-skip"), event: "advance", reason: "skip clarify", patch: { current_phase: "spec", next_phase: "execute" } });
  assert.equal(undeclared.error.code, "phase_skip_not_declared");
  fx.controller.close();
});

test("caller phase arithmetic is rejected and execution cannot be bypassed", () => {
  const fx = fixture();
  const skipped = fx.controller.selectRoute({ flow_id: "flow-1", expected_revision: 0, request_digest: sha256("skip-required"), chosen_procedure: "implement", why: "bad route", skipped_phases: ["spec"], confidence: "high" });
  assert.equal(skipped.error.code, "caller_phase_arithmetic_forbidden");
  const bypass = fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 0, request_digest: sha256("review-bypass"), event: "advance", reason: "skip execution", patch: { current_phase: "review", next_phase: "close" } });
  assert.equal(bypass.error.code, "execute_required");
  fx.controller.close();
});

test("completed phases remain valid after a scope rework loop", () => {
  const fx = fixture();
  const route = fx.controller.selectRoute({ flow_id: "flow-1", expected_revision: 0, request_digest: sha256("rework-route"), chosen_procedure: "implement", why: "rework test", confidence: "high" });
  assert.equal(route.ok, true, JSON.stringify(route));
  assert.equal(fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 1, request_digest: sha256("rework-clarify"), event: "advance", reason: "clarify", patch: { current_phase: "clarify", next_phase: "spec" } }).ok, true);
  assert.equal(fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 2, request_digest: sha256("rework-spec"), event: "advance", reason: "spec", patch: { current_phase: "spec", next_phase: "execute" } }).ok, true);
  assert.equal(fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 3, request_digest: sha256("rework-execute"), event: "advance", reason: "execute", patch: { current_phase: "execute", next_phase: "review" } }).ok, true);
  assert.equal(fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 4, request_digest: sha256("rework-scope"), event: "advance", reason: "scope changed", patch: { current_phase: "clarify", next_phase: "execute" } }).ok, true);
  const repeated = fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 5, request_digest: sha256("rework-repeat"), event: "advance", reason: "resume execute", patch: { current_phase: "execute", next_phase: "review" } });
  assert.equal(repeated.ok, true, JSON.stringify(repeated));
  fx.controller.close();
});

test("review findings cannot be silently removed and P0/P1 require reverification", () => {
  const fx = fixture({ criteria: [], types: [] });
  assert.equal(fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 0, request_digest: sha256("review-spec"), event: "advance", reason: "spec", patch: { current_phase: "spec", next_phase: "execute" } }).ok, true);
  assert.equal(fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 1, request_digest: sha256("review-execute"), event: "advance", reason: "execute", patch: { current_phase: "execute", next_phase: "review" } }).ok, true);
  assert.equal(fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 2, request_digest: sha256("review-phase"), event: "advance", reason: "review", patch: { current_phase: "review", next_phase: "close" } }).ok, true);
  assert.equal(fx.controller.recordReviewFindings({ flow_id: "flow-1", expected_revision: 3, request_digest: sha256("review-findings"), review_findings: [{ finding_id: "F-P1", severity: "P1", disposition: "open" }] }).ok, true);
  const removed = fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 4, request_digest: sha256("remove-finding"), event: "advance", reason: "bad removal", patch: { review_findings: [], current_phase: "review", next_phase: "close" } });
  assert.equal(removed.error.code, "review_finding_removed");
  const p0 = fx.controller.closeFlow({ flow_id: "flow-1", expected_revision: 4, request_digest: sha256("p0-close"), terminal_observation: null });
  assert.equal(p0.error.code, "completion_gate_failed");
  assert.equal(p0.error.unmet_criteria.some((item) => item.kind === "review-reverification"), true);
  fx.controller.close();
});

test("transaction backups are bounded and isolated", () => {
  const fx = fixture({ criteria: [], types: [] });
  for (let index = 0; index < 8; index += 1) {
    const result = fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: index, request_digest: sha256(`backup-${index}`), event: "advance", reason: "backup retention", patch: { current_phase: index === 0 ? "spec" : "spec", next_phase: "execute" } });
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  const backupDir = join(fx.root, ".delivery-control-backups");
  assert.equal(existsSync(backupDir), true);
  assert.ok(readdirSync(backupDir).filter((name) => name.endsWith(".bak")).length <= 5);
  assert.equal(readdirSync(fx.root).some((name) => name.endsWith(".bak")), false);
  fx.controller.close();
});

test("schema version 1 databases migrate authorization digest columns", () => {
  const root = mkdtempSync(join(tmpdir(), "delivery-control-migrate-"));
  roots.push(root);
  const dbPath = join(root, "legacy.sqlite");
  const legacy = new DatabaseSync(dbPath);
  legacy.exec("CREATE TABLE schema_meta(version INTEGER NOT NULL); INSERT INTO schema_meta VALUES(1); CREATE TABLE authorizations (authorization_id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, environment TEXT NOT NULL, request_digest TEXT NOT NULL, expires_at TEXT NOT NULL, nonce TEXT NOT NULL UNIQUE, challenge_digest TEXT NOT NULL, confirmed_by TEXT, confirmed_at TEXT, consumed_at TEXT, created_at TEXT NOT NULL);");
  legacy.close();
  const controller = new DeliveryControl({ dbPath });
  const probe = new DatabaseSync(dbPath);
  const columns = probe.prepare("PRAGMA table_info(authorizations)").all().map((column) => column.name);
  const version = probe.prepare("SELECT version FROM schema_meta").get().version;
  probe.close();
  assert.equal(version, 5);
  assert.ok(columns.includes("control_request_digest"));
  assert.ok(columns.includes("consumed_request_digest"));
  controller.close();
});

test("schema version 4 databases migrate generation-bound action result receipts", () => {
  const root = mkdtempSync(join(tmpdir(), "delivery-control-migrate-v4-"));
  roots.push(root);
  const dbPath = join(root, "legacy-v4.sqlite");
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE schema_meta(version INTEGER NOT NULL); INSERT INTO schema_meta VALUES(4);
    CREATE TABLE authorizations (authorization_id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, environment TEXT NOT NULL, request_digest TEXT NOT NULL, control_request_digest TEXT NOT NULL DEFAULT '', expires_at TEXT NOT NULL, nonce TEXT NOT NULL UNIQUE, challenge_digest TEXT NOT NULL, confirmed_by TEXT, confirmed_at TEXT, confirmed_request_digest TEXT, consumed_at TEXT, consumed_request_digest TEXT, created_at TEXT NOT NULL);
    CREATE TABLE external_action_results (action_result_id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, authorization_id TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, environment TEXT NOT NULL, action_request_digest TEXT NOT NULL, outcome TEXT NOT NULL, observed_at TEXT NOT NULL, producer TEXT NOT NULL, result_digest TEXT NOT NULL, supersedes TEXT, delivery_generation INTEGER NOT NULL);
  `);
  legacy.close();
  const controller = new DeliveryControl({ dbPath });
  const probe = new DatabaseSync(dbPath);
  const authColumns = probe.prepare("PRAGMA table_info(authorizations)").all().map((column) => column.name);
  const resultColumns = probe.prepare("PRAGMA table_info(external_action_results)").all().map((column) => column.name);
  assert.equal(probe.prepare("SELECT version FROM schema_meta").get().version, 5);
  probe.close();
  assert.ok(authColumns.includes("delivery_generation"));
  for (const column of ["artifact", "artifact_digest", "command_or_request_id", "legacy_unverified"]) assert.ok(resultColumns.includes(column), column);
  controller.close();
});

test("delivery generation owns a revisioned fixed point", () => {
  const fx = fixture();
  const initial = fx.controller.inspectFlow("flow-1").flow;
  assert.equal(initial.delivery_generation, 1);
  assert.equal(initial.scope_digest, sha256("scope:v1"));
  assert.deepEqual(initial.fixed_point, { generation: 1, spec_digest: null, implementation_digest: null, review_digest: null });

  const specDigest = sha256("approved-spec-v1");
  assert.equal(fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 0, request_digest: sha256("enter-spec-v1"), event: "advance", reason: "enter spec", patch: { current_phase: "spec", next_phase: "execute" } }).ok, true);
  const spec = fx.controller.completePhase({ flow_id: "flow-1", expected_revision: 1, request_digest: sha256("complete-spec-v1"), phase: "spec", outcome: "completed", artifact_digest: specDigest });
  assert.equal(spec.ok, true, JSON.stringify(spec));
  assert.equal(spec.flow.fixed_point.spec_digest, specDigest);

  const nextScope = sha256("scope:v2");
  const revised = fx.controller.reviseScope({ flow_id: "flow-1", expected_revision: 2, request_digest: sha256("revise-scope-v2"), scope_digest: nextScope, reason: "Acceptance changed" });
  assert.equal(revised.ok, true, JSON.stringify(revised));
  assert.equal(revised.flow.delivery_generation, 2);
  assert.equal(revised.flow.scope_digest, nextScope);
  assert.deepEqual(revised.flow.fixed_point, { generation: 2, spec_digest: null, implementation_digest: null, review_digest: null });
  fx.controller.close();
});

test("evidence and review fixed points cannot cross delivery generations", () => {
  const fx = fixture({ criteria: [{ acceptance_id: "AC-1", description: "works" }], types: ["test"] });
  const artifact = join(fx.root, "generation-proof.txt");
  writeFileSync(artifact, "generation one");
  const oldEvidence = fx.controller.addEvidence({ flow_id: "flow-1", expected_revision: 0, request_digest: sha256("old-generation-evidence"), evidence: {
    evidence_id: "E-old-generation", acceptance_ids: ["AC-1"], type: "test", result: "verified", artifact,
    artifact_digest: sha256(readFileSync(artifact)), command_or_request_id: "generation-test", observed_at: new Date().toISOString(), producer: "test", environment: "local",
    delivery_generation: 1, subject_digest: sha256("scope:v1")
  }});
  assert.equal(oldEvidence.ok, true, JSON.stringify(oldEvidence));
  assert.equal(fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 1, request_digest: sha256("generation-enter-spec"), event: "advance", reason: "enter spec", patch: { current_phase: "spec", next_phase: "execute" } }).ok, true);
  assert.equal(fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 2, request_digest: sha256("generation-enter-execute"), event: "advance", reason: "enter execute", patch: { current_phase: "execute", next_phase: "review" } }).ok, true);
  const review = fx.controller.recordReviewFindings({ flow_id: "flow-1", expected_revision: 3, request_digest: sha256("generation-review"), review_findings: [{
    finding_id: "F-old", severity: "P2", disposition: "accepted", reason: "accepted in generation one", delivery_generation: 1, fixed_point_digest: sha256("scope:v1"), review_run_id: "review-v1"
  }] });
  assert.equal(review.ok, true, JSON.stringify(review));
  const revised = fx.controller.reviseScope({ flow_id: "flow-1", expected_revision: 4, request_digest: sha256("generation-revise"), scope_digest: sha256("scope:v2"), reason: "Scope changed" });
  assert.equal(revised.ok, true, JSON.stringify(revised));
  const validation = fx.controller.validateEvidence({ flow_id: "flow-1" });
  assert.equal(validation.valid, false);
  assert.equal(validation.ignored_evidence.some((item) => item.reason === "stale-generation"), true);
  const freshArtifact = join(fx.root, "generation-two-proof.txt");
  writeFileSync(freshArtifact, "generation two");
  const fresh = fx.controller.addEvidence({ flow_id: "flow-1", expected_revision: 5, request_digest: sha256("new-generation-evidence"), evidence: {
    evidence_id: "E-new-generation", acceptance_ids: ["AC-1"], type: "test", result: "verified", artifact: freshArtifact,
    artifact_digest: sha256(readFileSync(freshArtifact)), command_or_request_id: "generation-two-test", observed_at: new Date().toISOString(), producer: "test", environment: "local"
  }});
  assert.equal(fresh.ok, true, JSON.stringify(fresh));
  assert.equal(fx.controller.validateEvidence({ flow_id: "flow-1" }).valid, true);
  fx.controller.close();
});

test("historical Review remains auditable without blocking a fresh generation Review", () => {
  const fx = fixture({ criteria: [], types: [] });
  assert.equal(fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 0, request_digest: sha256("old-review-spec"), event: "advance", reason: "spec", patch: { current_phase: "spec", next_phase: "execute" } }).ok, true);
  assert.equal(fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 1, request_digest: sha256("old-review-execute"), event: "advance", reason: "execute", patch: { current_phase: "execute", next_phase: "review" } }).ok, true);
  assert.equal(fx.controller.recordReviewFindings({ flow_id: "flow-1", expected_revision: 2, request_digest: sha256("old-review-finding"), review_findings: [{ finding_id: "F-old-generation", severity: "P2", disposition: "accepted", reason: "generation one" }] }).ok, true);
  assert.equal(fx.controller.reviseScope({ flow_id: "flow-1", expected_revision: 3, request_digest: sha256("review-new-scope"), scope_digest: sha256("scope:v2"), reason: "new generation" }).ok, true);
  assert.equal(fx.controller.markNativePlanUnavailable({ flow_id: "flow-1", expected_revision: 4, request_digest: sha256("review-plan-unavailable"), handoff: "native Plan unavailable" }).ok, true);
  assert.equal(fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 5, request_digest: sha256("new-review-spec"), event: "advance", reason: "spec", patch: { current_phase: "spec", next_phase: "execute" } }).ok, true);
  assert.equal(fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 6, request_digest: sha256("new-review-execute"), event: "advance", reason: "execute", patch: { current_phase: "execute", next_phase: "review" } }).ok, true);
  assert.equal(fx.controller.recordReviewFindings({ flow_id: "flow-1", expected_revision: 7, request_digest: sha256("new-review-finding"), review_findings: [{ finding_id: "F-new-generation", severity: "P2", disposition: "accepted", reason: "generation two" }] }).ok, true);
  assert.equal(fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 8, request_digest: sha256("new-review-complete"), event: "advance", reason: "review", patch: { current_phase: "review", next_phase: "close" } }).ok, true);
  const terminal = join(fx.root, "review-generation-terminal.txt");
  writeFileSync(terminal, "complete");
  const evidence = fx.controller.addEvidence({ flow_id: "flow-1", expected_revision: 9, request_digest: sha256("review-generation-terminal-evidence"), evidence: { evidence_id: "E-review-generation", acceptance_ids: ["terminal"], type: "terminal", result: "observed", artifact: terminal, artifact_digest: sha256(readFileSync(terminal)), command_or_request_id: "review-generation", observed_at: new Date().toISOString(), producer: "test", environment: "local" } });
  assert.equal(evidence.ok, true, JSON.stringify(evidence));
  const closed = fx.controller.closeFlow({ flow_id: "flow-1", expected_revision: 10, request_digest: sha256("review-generation-close"), terminal_observation: { evidence_id: "E-review-generation", artifact: terminal, artifact_digest: sha256(readFileSync(terminal)), observed_at: new Date().toISOString(), result: "observed" } });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  assert.equal(closed.flow.review_findings.length, 2);
  fx.controller.close();
});

test("low-confidence route waits for explicit confirmation", () => {
  const fx = fixture();
  const pending = fx.controller.selectRoute({ flow_id: "flow-1", expected_revision: 0, request_digest: sha256("low-route"), chosen_procedure: "implement", why: "two procedures fit", confidence: "low" });
  assert.equal(pending.ok, true, JSON.stringify(pending));
  assert.equal(pending.flow.status, "awaiting-user");
  assert.equal(pending.flow.next_phase, "route");
  const confirmed = fx.controller.selectRoute({ flow_id: "flow-1", expected_revision: 1, request_digest: sha256("confirm-route"), chosen_procedure: "implement", why: "user selected", confidence: "low", confirmed: true });
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
  assert.equal(confirmed.flow.status, "active");
  assert.deepEqual(confirmed.flow.route.phase_sequence, ["route", "clarify", "spec", "execute", "review", "close"]);
  assert.equal(confirmed.flow.next_phase, "clarify");
  fx.controller.close();
});

test("high-level phase advance derives next phase from the route template", () => {
  const fx = fixture();
  const routed = fx.controller.selectRoute({ flow_id: "flow-1", expected_revision: 0, request_digest: sha256("template-route"), chosen_procedure: "implement", why: "standard delivery", confidence: "high" });
  assert.equal(routed.ok, true, JSON.stringify(routed));
  const pending = fx.controller.advancePhase({ flow_id: "flow-1", expected_revision: 1, request_digest: sha256("finish-route-pending"), phase: "route", outcome: "completed", reason: "route selected" });
  assert.equal(pending.error.code, "native_plan_sync_required");
  assert.equal(fx.controller.markNativePlanUnavailable({ flow_id: "flow-1", expected_revision: 1, request_digest: sha256("route-plan-unavailable"), handoff: "test host has no native Plan" }).ok, true);
  const clarify = fx.controller.advancePhase({ flow_id: "flow-1", expected_revision: 2, request_digest: sha256("finish-route"), phase: "route", outcome: "completed", reason: "route selected" });
  assert.equal(clarify.flow.current_phase, "clarify");
  assert.equal(clarify.flow.next_phase, "spec");
  assert.equal(fx.controller.markNativePlanUnavailable({ flow_id: "flow-1", expected_revision: 3, request_digest: sha256("clarify-plan-unavailable"), handoff: "test host has no native Plan" }).ok, true);
  const rejected = fx.controller.advancePhase({ flow_id: "flow-1", expected_revision: 4, request_digest: sha256("caller-next"), phase: "clarify", outcome: "completed", next_phase: "close", reason: "attempt bypass" });
  assert.equal(rejected.flow.current_phase, "spec");
  assert.equal(rejected.flow.next_phase, "execute");
  fx.controller.close();
});

test("high-level route reaches close only through synchronized fixed points", () => {
  const fx = fixture({ criteria: [], types: [] });
  let revision = 0;
  const route = fx.controller.selectRoute({ flow_id: "flow-1", expected_revision: revision, request_digest: sha256("e2e-route"), chosen_procedure: "implement", why: "full high-level route", confidence: "high" });
  assert.equal(route.ok, true, JSON.stringify(route)); revision = route.flow.revision;
  const advance = (phase, artifactDigest = undefined) => {
    const unavailable = fx.controller.markNativePlanUnavailable({ flow_id: "flow-1", expected_revision: revision, request_digest: sha256(`e2e-plan-${phase}`), handoff: `native Plan unavailable at ${phase}` });
    assert.equal(unavailable.ok, true, JSON.stringify(unavailable)); revision = unavailable.flow.revision;
    const moved = fx.controller.advancePhase({ flow_id: "flow-1", expected_revision: revision, request_digest: sha256(`e2e-advance-${phase}`), phase, outcome: "completed", artifact_digest: artifactDigest, reason: `complete ${phase}` });
    assert.equal(moved.ok, true, JSON.stringify(moved)); revision = moved.flow.revision;
  };
  advance("route");
  advance("clarify");
  advance("spec", sha256("e2e-spec"));
  advance("execute", sha256("e2e-implementation"));
  advance("review", sha256("e2e-review"));
  const finalPlan = fx.controller.markNativePlanUnavailable({ flow_id: "flow-1", expected_revision: revision, request_digest: sha256("e2e-plan-close"), handoff: "native Plan unavailable at close" });
  assert.equal(finalPlan.ok, true, JSON.stringify(finalPlan)); revision = finalPlan.flow.revision;
  const terminal = join(fx.root, "e2e-terminal.txt");
  writeFileSync(terminal, "complete");
  const terminalEvidence = fx.controller.addEvidence({ flow_id: "flow-1", expected_revision: revision, request_digest: sha256("e2e-terminal-evidence"), evidence: { evidence_id: "E-e2e-terminal", acceptance_ids: ["terminal"], type: "terminal", result: "observed", artifact: terminal, artifact_digest: sha256(readFileSync(terminal)), command_or_request_id: "e2e-terminal", observed_at: new Date().toISOString(), producer: "test", environment: "local" } });
  assert.equal(terminalEvidence.ok, true, JSON.stringify(terminalEvidence)); revision = terminalEvidence.flow.revision;
  const closed = fx.controller.closeFlow({ flow_id: "flow-1", expected_revision: revision, request_digest: sha256("e2e-close"), terminal_observation: { evidence_id: "E-e2e-terminal", artifact: terminal, artifact_digest: sha256(readFileSync(terminal)), observed_at: new Date().toISOString(), result: "observed" } });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  assert.equal(closed.flow.status, "complete");
  fx.controller.close();
});

test("route and phase boundaries invalidate a previously confirmed native Plan", () => {
  const fx = fixture();
  const projected = fx.controller.projectNativePlan({ flow_id: "flow-1", expected_revision: 0, request_digest: sha256("stale-plan-project") });
  const confirmed = fx.controller.confirmNativePlan({ flow_id: "flow-1", expected_revision: 0, request_digest: sha256("stale-plan-confirm"), projection_id: projected.projection_id, projection_revision: projected.projection_revision, applied_steps: projected.plan.steps });
  assert.equal(confirmed.flow.plan_sync, "confirmed");
  const routed = fx.controller.selectRoute({ flow_id: "flow-1", expected_revision: 1, request_digest: sha256("stale-plan-route"), chosen_procedure: "implement", why: "route boundary", confidence: "high" });
  assert.equal(routed.flow.plan_sync, "pending");
  assert.equal(routed.flow.native_plan_digest, null);
  fx.controller.close();
});

test("a routed flow cannot close without spec implementation and review fixed points", () => {
  const fx = fixture({ criteria: [], types: [] });
  assert.equal(fx.controller.markNativePlanUnavailable({ flow_id: "flow-1", expected_revision: 0, request_digest: sha256("fixed-point-plan-unavailable"), handoff: "native Plan unavailable" }).ok, true);
  assert.equal(fx.controller.selectRoute({ flow_id: "flow-1", expected_revision: 1, request_digest: sha256("fixed-point-route"), chosen_procedure: "implement", why: "main route", confidence: "high" }).ok, true);
  assert.equal(fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 2, request_digest: sha256("fixed-point-clarify"), event: "advance", reason: "clarify", patch: { current_phase: "clarify", next_phase: "spec" } }).ok, true);
  assert.equal(fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 3, request_digest: sha256("fixed-point-spec"), event: "advance", reason: "spec", patch: { current_phase: "spec", next_phase: "execute" } }).ok, true);
  assert.equal(fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 4, request_digest: sha256("fixed-point-execute"), event: "advance", reason: "execute", patch: { current_phase: "execute", next_phase: "review" } }).ok, true);
  assert.equal(fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 5, request_digest: sha256("fixed-point-review"), event: "advance", reason: "review", patch: { current_phase: "review", next_phase: "close" } }).ok, true);
  const terminal = join(fx.root, "fixed-point-terminal.txt");
  writeFileSync(terminal, "terminal");
  assert.equal(fx.controller.addEvidence({ flow_id: "flow-1", expected_revision: 6, request_digest: sha256("fixed-point-terminal-evidence"), evidence: { evidence_id: "E-fixed-terminal", acceptance_ids: ["terminal"], type: "terminal", result: "observed", artifact: terminal, artifact_digest: sha256(readFileSync(terminal)), command_or_request_id: "fixed-terminal", observed_at: new Date().toISOString(), producer: "test", environment: "local" } }).ok, true);
  const closed = fx.controller.closeFlow({ flow_id: "flow-1", expected_revision: 7, request_digest: sha256("fixed-point-close"), terminal_observation: { evidence_id: "E-fixed-terminal", artifact: terminal, artifact_digest: sha256(readFileSync(terminal)), observed_at: new Date().toISOString(), result: "observed" } });
  assert.equal(closed.error.code, "completion_gate_failed");
  assert.deepEqual(closed.error.unmet_criteria.filter((item) => item.kind === "fixed-point").map((item) => item.phase).sort(), ["execute", "review", "spec"]);
  fx.controller.close();
});

test("high-level flow operations return projections and evidence gates", () => {
  const fx = fixture();
  const started = fx.controller.startOrResumeFlow({ flow_id: "flow-1", expected_revision: 0, request_digest: sha256("resume"), plan_root: fx.root, plan_target: fx.target, terminal_condition: "All acceptance evidence is verified", resume_point: "route" });
  assert.equal(started.ok, true, JSON.stringify(started));
  const advanced = fx.controller.advanceFlow({ flow_id: "flow-1", expected_revision: 0, request_digest: sha256("advance-high-level"), event: "advance", reason: "enter spec", patch: { current_phase: "spec", next_phase: "execute" } });
  assert.equal(advanced.ok, true, JSON.stringify(advanced));
  assert.equal(advanced.native_plan_projection.ok, true);
  const artifact = join(fx.root, "relative-proof.txt");
  writeFileSync(artifact, "relative");
  const evidence = fx.controller.recordDeliveryEvidence({ flow_id: "flow-1", expected_revision: 1, request_digest: sha256("relative-evidence"), evidence: { evidence_id: "E-relative", acceptance_ids: ["AC-1"], type: "test", result: "verified", artifact: "relative-proof.txt", artifact_digest: sha256(readFileSync(artifact)), command_or_request_id: "relative-test", observed_at: new Date().toISOString(), producer: "test", environment: "local" }});
  assert.equal(evidence.ok, true, JSON.stringify(evidence));
  assert.equal(evidence.flow.evidence_records[0].artifact, artifact);
  fx.controller.close();
});

test("review disposition is a completion gate", () => {
  const fx = fixture({ criteria: [], types: [] });
  assert.equal(fx.controller.markNativePlanUnavailable({ flow_id: "flow-1", expected_revision: 0, request_digest: sha256("review-gate-unavailable"), handoff: "native Plan unavailable" }).ok, true);
  assert.equal(fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 1, request_digest: sha256("review-gate-spec"), event: "advance", reason: "spec", patch: { current_phase: "spec", next_phase: "execute" } }).ok, true);
  assert.equal(fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 2, request_digest: sha256("review-gate-execute"), event: "advance", reason: "execute", patch: { current_phase: "execute", next_phase: "review" } }).ok, true);
  const reviewed = fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 3, request_digest: sha256("review-gate-phase"), event: "advance", reason: "review", patch: { current_phase: "review", next_phase: "close" } });
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed));
  const findings = fx.controller.recordReviewFindings({ flow_id: "flow-1", expected_revision: 4, request_digest: sha256("review-findings"), review_findings: [{ finding_id: "F-1", severity: "P1", disposition: "fixed", reason: "patched" }] });
  assert.equal(findings.ok, true, JSON.stringify(findings));
  const blocked = fx.controller.closeFlow({ flow_id: "flow-1", expected_revision: 5, request_digest: sha256("review-gate-close"), terminal_observed: true });
  assert.equal(blocked.error.code, "completion_gate_failed");
  assert.equal(blocked.error.unmet_criteria.some((item) => item.kind === "review-reverification"), true);
  fx.controller.close();
});

test("malformed markers freeze recovery instead of overwriting", () => {
  const fx = fixture();
  const text = readFileSync(fx.target, "utf8");
  writeFileSync(fx.target, `${text}\n<!-- delivery-control:state:start -->\n`);
  const result = fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 0, request_digest: sha256("marker"), event: "advance", reason: "move", patch: { current_phase: "spec" } });
  assert.equal(result.error.code, "plan_tree_drift");
  assert.equal(fx.controller.inspectFlow("flow-1").flow.frozen, true);
  fx.controller.close();
});

test("superseded evidence is retained but does not block closure", () => {
  const fx = fixture();
  const oldArtifact = join(fx.root, "old.txt");
  const newArtifact = join(fx.root, "new.txt");
  writeFileSync(oldArtifact, "old"); writeFileSync(newArtifact, "new");
  assert.equal(fx.controller.addEvidence({ flow_id: "flow-1", expected_revision: 0, request_digest: sha256("old"), evidence: {
    evidence_id: "E-old", acceptance_ids: ["AC-1"], type: "test", result: "passed", artifact: oldArtifact,
    artifact_digest: sha256(readFileSync(oldArtifact)), command_or_request_id: "old", observed_at: new Date().toISOString(), producer: "test", environment: "local"
  }}).ok, true);
  assert.equal(fx.controller.addEvidence({ flow_id: "flow-1", expected_revision: 1, request_digest: sha256("new"), evidence: {
    evidence_id: "E-new", acceptance_ids: ["AC-1"], type: "test", result: "verified", artifact: newArtifact,
    artifact_digest: sha256(readFileSync(newArtifact)), command_or_request_id: "new", observed_at: new Date().toISOString(), producer: "test", environment: "local", supersedes: "E-old"
  }}).ok, true);
  writeFileSync(oldArtifact, "mutated after supersede");
  const result = fx.controller.validateEvidence({ flow_id: "flow-1" });
  assert.equal(result.valid, true, JSON.stringify(result));
  assert.equal(result.ignored_evidence[0].reason, "superseded");
  fx.controller.close();
});

test("close gate requires consumed receipts for declared external actions", () => {
  const requestDigest = sha256("deploy-exact");
  const fx = fixture({ criteria: [], types: [], actions: [{ action: "deploy", target: "app", environment: "prod", request_digest: requestDigest }] });
  assert.equal(fx.controller.markNativePlanUnavailable({ flow_id: "flow-1", expected_revision: 0, request_digest: sha256("unavailable"), handoff: "native Plan unavailable" }).ok, true);
  const blocked = fx.controller.closeFlow({ flow_id: "flow-1", expected_revision: 1, request_digest: sha256("close-before-auth"), terminal_observed: true });
  assert.equal(blocked.error.code, "completion_gate_failed");
  assert.equal(blocked.error.unmet_criteria.some((item) => item.kind === "authorization"), true);
  const requested = fx.controller.requestAuthorization({ flow_id: "flow-1", expected_revision: 1, action: "deploy", target: "app", environment: "prod", request_digest: requestDigest, elicitation_supported: false });
  assert.equal(fx.controller.confirmAuthorization({ flow_id: "flow-1", expected_revision: 1, request_digest: requestDigest, authorization_id: requested.authorization_id, mode: "challenge", challenge_code: requested.confirmation.challenge_code }).ok, true);
  assert.equal(fx.controller.consumeAuthorization({ flow_id: "flow-1", expected_revision: 1, authorization_id: requested.authorization_id, action: "deploy", target: "app", environment: "prod", request_digest: requestDigest }).ok, true);
  const permissionOnly = fx.controller.closeFlow({ flow_id: "flow-1", expected_revision: 2, request_digest: sha256("close-with-permission-only"), terminal_observed: true });
  assert.equal(permissionOnly.error.unmet_criteria.some((item) => item.kind === "external-action-result"), true);
  const failedReceipt = join(fx.root, "failed-deploy.json");
  writeFileSync(failedReceipt, '{"status":"failed"}');
  const failedAction = fx.controller.recordExternalActionResult({
    flow_id: "flow-1", expected_revision: 2, request_digest: sha256("record-failed-deploy"),
    result: { action_result_id: "AR-failed", authorization_id: requested.authorization_id, action: "deploy", target: "app", environment: "prod", action_request_digest: requestDigest, outcome: "failed", observed_at: new Date().toISOString(), producer: "deploy-runner", result_digest: sha256("deploy-failed"), artifact: failedReceipt, artifact_digest: sha256(readFileSync(failedReceipt)), command_or_request_id: "deploy-request-1" }
  });
  assert.equal(failedAction.ok, true, JSON.stringify(failedAction));
  const stillBlocked = fx.controller.closeFlow({ flow_id: "flow-1", expected_revision: 3, request_digest: sha256("close-after-failed-action"), terminal_observed: true });
  assert.equal(stillBlocked.error.unmet_criteria.some((item) => item.kind === "external-action-failed"), true);
  const reused = fx.controller.recordExternalActionResult({ flow_id: "flow-1", expected_revision: 3, request_digest: sha256("reuse-deploy-auth"), result: { action_result_id: "AR-reused", authorization_id: requested.authorization_id, action: "deploy", target: "app", environment: "prod", action_request_digest: requestDigest, outcome: "succeeded", observed_at: new Date().toISOString(), producer: "deploy-runner", result_digest: sha256("invalid-retry"), artifact: failedReceipt, artifact_digest: sha256(readFileSync(failedReceipt)), command_or_request_id: "deploy-request-reused" } });
  assert.equal(reused.error.code, "authorization_result_already_recorded");
  const retryAuth = fx.controller.requestAuthorization({ flow_id: "flow-1", expected_revision: 3, action: "deploy", target: "app", environment: "prod", request_digest: requestDigest, elicitation_supported: false });
  assert.equal(fx.controller.confirmAuthorization({ flow_id: "flow-1", expected_revision: 3, request_digest: requestDigest, authorization_id: retryAuth.authorization_id, mode: "challenge", challenge_code: retryAuth.confirmation.challenge_code }).ok, true);
  assert.equal(fx.controller.consumeAuthorization({ flow_id: "flow-1", expected_revision: 3, authorization_id: retryAuth.authorization_id, action: "deploy", target: "app", environment: "prod", request_digest: requestDigest }).ok, true);
  const successReceipt = join(fx.root, "successful-deploy.json");
  writeFileSync(successReceipt, '{"status":"succeeded"}');
  const succeededAction = fx.controller.recordExternalActionResult({
    flow_id: "flow-1", expected_revision: 4, request_digest: sha256("record-successful-deploy"),
    result: { action_result_id: "AR-success", authorization_id: retryAuth.authorization_id, action: "deploy", target: "app", environment: "prod", action_request_digest: requestDigest, outcome: "succeeded", observed_at: new Date().toISOString(), producer: "deploy-runner", result_digest: sha256("deploy-succeeded"), supersedes: "AR-failed", artifact: successReceipt, artifact_digest: sha256(readFileSync(successReceipt)), command_or_request_id: "deploy-request-2" }
  });
  assert.equal(succeededAction.ok, true, JSON.stringify(succeededAction));
  const terminal = join(fx.root, "terminal.txt");
  writeFileSync(terminal, "terminal");
  assert.equal(fx.controller.addEvidence({ flow_id: "flow-1", expected_revision: 5, request_digest: sha256("terminal-evidence"), evidence: { evidence_id: "E-terminal", acceptance_ids: ["terminal"], type: "terminal", result: "observed", artifact: terminal, artifact_digest: sha256(readFileSync(terminal)), command_or_request_id: "terminal", observed_at: new Date().toISOString(), producer: "test", environment: "local" } }).ok, true);
  assert.equal(fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 6, request_digest: sha256("spec-after-auth"), event: "advance", reason: "spec completed", patch: { current_phase: "spec", next_phase: "execute" } }).ok, true);
  assert.equal(fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 7, request_digest: sha256("execute-after-auth"), event: "advance", reason: "execute completed", patch: { current_phase: "execute", next_phase: "review" } }).ok, true);
  const reviewed = fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 8, request_digest: sha256("review-after-auth"), event: "advance", reason: "review completed", patch: { current_phase: "review", next_phase: "close" } });
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed));
  writeFileSync(successReceipt, '{"status":"tampered"}');
  const tampered = fx.controller.closeFlow({ flow_id: "flow-1", expected_revision: 9, request_digest: sha256("close-with-tampered-action-result"), terminal_observation: { evidence_id: "E-terminal", artifact: terminal, artifact_digest: sha256(readFileSync(terminal)), observed_at: new Date().toISOString(), result: "observed" } });
  assert.equal(tampered.error.unmet_criteria.some((item) => item.kind === "external-action-result-unverified"), true);
  writeFileSync(successReceipt, '{"status":"succeeded"}');
  const closed = fx.controller.closeFlow({ flow_id: "flow-1", expected_revision: 9, request_digest: sha256("close-after-auth"), terminal_observation: { evidence_id: "E-terminal", artifact: terminal, artifact_digest: sha256(readFileSync(terminal)), observed_at: new Date().toISOString(), result: "observed" } });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  fx.controller.close();
});

test("Plan Tree rebuild preserves evidence and native Plan completion gates", () => {
  const fx = fixture();
  const artifact = join(fx.root, "durable-proof.txt");
  writeFileSync(artifact, "durable");
  const evidence = fx.controller.addEvidence({ flow_id: "flow-1", expected_revision: 0, request_digest: sha256("durable-evidence"), evidence: {
    evidence_id: "E-durable", acceptance_ids: ["AC-1"], type: "test", result: "verified", artifact,
    artifact_digest: sha256(readFileSync(artifact)), command_or_request_id: "durable", observed_at: new Date().toISOString(), producer: "test", environment: "local"
  }});
  assert.equal(evidence.ok, true);
  const projection = fx.controller.projectNativePlan({ flow_id: "flow-1", expected_revision: 1, request_digest: sha256("durable-project") });
  assert.equal(projection.ok, true);
  const confirmed = fx.controller.confirmNativePlan({ flow_id: "flow-1", expected_revision: 1, request_digest: sha256("durable-confirm"), projection_id: projection.projection_id, projection_revision: projection.projection_revision, applied_steps: projection.plan.steps });
  assert.equal(confirmed.ok, true);
  fx.controller.close();
  const rebuilt = new DeliveryControl({ dbPath: join(fx.root, "fresh.sqlite") });
  const recovered = rebuilt.recoverFlow({ flow_id: "flow-1", expected_revision: 0, request_digest: sha256("durable-rebuild"), plan_root: fx.root, plan_target: fx.target });
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(recovered.flow.revision, 2);
  assert.equal(recovered.flow.evidence_records.length, 1);
  assert.equal(recovered.flow.plan_sync, "confirmed");
  assert.equal(rebuilt.commitTransition({ flow_id: "flow-1", expected_revision: 2, request_digest: sha256("durable-spec"), event: "advance", reason: "spec completed", patch: { current_phase: "spec", next_phase: "execute" } }).ok, true);
  assert.equal(rebuilt.commitTransition({ flow_id: "flow-1", expected_revision: 3, request_digest: sha256("durable-execute"), event: "advance", reason: "execute completed", patch: { current_phase: "execute", next_phase: "review" } }).ok, true);
  const reviewed = rebuilt.commitTransition({ flow_id: "flow-1", expected_revision: 4, request_digest: sha256("durable-review"), event: "advance", reason: "review completed", patch: { current_phase: "review", next_phase: "close" } });
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed));
  const evidenceArtifact = artifact;
  const closed = rebuilt.closeFlow({ flow_id: "flow-1", expected_revision: 5, request_digest: sha256("durable-close"), terminal_observation: { evidence_id: "E-durable", artifact: evidenceArtifact, artifact_digest: sha256(readFileSync(evidenceArtifact)), observed_at: new Date().toISOString(), result: "verified" } });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  rebuilt.close();
});
