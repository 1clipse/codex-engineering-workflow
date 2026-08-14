import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeliveryControl, sha256 } from "../src/core.mjs";

const roots = [];
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
    terminal_condition: "All acceptance evidence is verified", resume_point: "route",
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

test("external Plan Tree edit freezes the flow", () => {
  const fx = fixture();
  writeFileSync(fx.target, `${readFileSync(fx.target, "utf8")}\nexternal edit\n`);
  const result = fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 0, event: "advance", reason: "move", patch: { current_phase: "spec" } });
  assert.equal(result.error.code, "plan_tree_drift");
  assert.equal(fx.controller.inspectFlow("flow-1").flow.frozen, true);
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
  assert.equal(fx.controller.confirmAuthorization({ flow_id: "flow-1", expected_revision: 0, request_digest: requestDigest, authorization_id: requested.authorization_id, mode: "challenge", challenge_code: "BAD" }).error.code, "challenge_mismatch");
  const confirmed = fx.controller.confirmAuthorization({ flow_id: "flow-1", expected_revision: 0, request_digest: requestDigest, authorization_id: requested.authorization_id, mode: "challenge", challenge_code: requested.confirmation.challenge_code });
  assert.equal(confirmed.ok, true);
  const mismatch = fx.controller.consumeAuthorization({ flow_id: "flow-1", expected_revision: 0, authorization_id: requested.authorization_id, action: "merge", target: "origin/main", environment: "github", request_digest: requestDigest });
  assert.equal(mismatch.error.code, "authorization_scope_mismatch");
  const consumed = fx.controller.consumeAuthorization({ flow_id: "flow-1", expected_revision: 0, authorization_id: requested.authorization_id, action: "push", target: "origin/main", environment: "github", request_digest: requestDigest });
  assert.equal(consumed.ok, true);
  const replay = fx.controller.consumeAuthorization({ flow_id: "flow-1", expected_revision: 1, authorization_id: requested.authorization_id, action: "push", target: "origin/main", environment: "github", request_digest: requestDigest });
  assert.equal(replay.error.code, "authorization_replayed");
  const expiring = fx.controller.requestAuthorization({ flow_id: "flow-1", expected_revision: 1, action: "deploy", target: "app", environment: "prod", request_digest: sha256("deploy"), ttl_ms: 10, elicitation_supported: false });
  fx.advance(11);
  assert.equal(fx.controller.confirmAuthorization({ flow_id: "flow-1", expected_revision: 1, request_digest: sha256("deploy"), authorization_id: expiring.authorization_id, mode: "challenge", challenge_code: expiring.confirmation.challenge_code }).error.code, "authorization_expired");
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
  const closed = fx.controller.closeFlow({ flow_id: "flow-1", expected_revision: 2, request_digest: sha256("close"), terminal_observed: true });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  assert.equal(closed.flow.status, "complete");
  fx.controller.close();
});

test("state machine rejects illegal phase and event transitions", () => {
  const fx = fixture();
  const review = fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 0, request_digest: sha256("to-review"), event: "advance", reason: "review", patch: { current_phase: "review", next_phase: "close" } });
  assert.equal(review.ok, true);
  const illegal = fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 1, request_digest: sha256("illegal"), event: "advance", reason: "bad", patch: { current_phase: "spec" } });
  assert.equal(illegal.error.code, "illegal_phase_transition");
  const eventRule = fx.controller.commitTransition({ flow_id: "flow-1", expected_revision: 1, request_digest: sha256("event"), event: "spec-not-ready", reason: "bad", patch: { current_phase: "execute" } });
  assert.equal(eventRule.error.code, "event_rule_violation");
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
  const fx = fixture({ criteria: [], types: [], actions: [{ action: "deploy", target: "app", environment: "prod" }] });
  assert.equal(fx.controller.markNativePlanUnavailable({ flow_id: "flow-1", expected_revision: 0, request_digest: sha256("unavailable"), handoff: "native Plan unavailable" }).ok, true);
  const blocked = fx.controller.closeFlow({ flow_id: "flow-1", expected_revision: 1, request_digest: sha256("close-before-auth"), terminal_observed: true });
  assert.equal(blocked.error.code, "completion_gate_failed");
  assert.equal(blocked.error.unmet_criteria.some((item) => item.kind === "authorization"), true);
  const requestDigest = sha256("deploy-exact");
  const requested = fx.controller.requestAuthorization({ flow_id: "flow-1", expected_revision: 1, action: "deploy", target: "app", environment: "prod", request_digest: requestDigest, elicitation_supported: false });
  assert.equal(fx.controller.confirmAuthorization({ flow_id: "flow-1", expected_revision: 1, request_digest: requestDigest, authorization_id: requested.authorization_id, mode: "challenge", challenge_code: requested.confirmation.challenge_code }).ok, true);
  assert.equal(fx.controller.consumeAuthorization({ flow_id: "flow-1", expected_revision: 1, authorization_id: requested.authorization_id, action: "deploy", target: "app", environment: "prod", request_digest: requestDigest }).ok, true);
  const closed = fx.controller.closeFlow({ flow_id: "flow-1", expected_revision: 2, request_digest: sha256("close-after-auth"), terminal_observed: true });
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
  const closed = rebuilt.closeFlow({ flow_id: "flow-1", expected_revision: 2, request_digest: sha256("durable-close"), terminal_observed: true });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  rebuilt.close();
});
