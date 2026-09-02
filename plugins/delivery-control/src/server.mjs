import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  DEFAULT_MODE, EVIDENCE_RESULTS, FLOW_VALUES, MODE_VALUES, PHASE_VALUES,
  REVIEW_DISPOSITIONS, REVIEW_SEVERITIES, SENSITIVE_ACTIONS, STRICT_ESCALATION_SIGNALS
} from "./constants.mjs";
import { DeliveryControl } from "./core.mjs";

const controller = new DeliveryControl();
const server = new McpServer(
  { name: "delivery-control", version: "3.0.0" },
  { instructions: "Use the JSON policy and Plan Tree as durable authority. This server controls delivery checkpoints, evidence, recovery, and exact external-action authorization. Codex native Plan/Goal is an optional session runtime aid, never a completion gate." }
);

const zEnum = (values) => z.enum([...values]);
const flowId = z.string().min(1);
const revision = z.number().int().nonnegative();
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const phaseValues = PHASE_VALUES.filter((phase) => phase !== "close");
const actionValues = [...SENSITIVE_ACTIONS];
const outcomeValues = ["completed", "awaiting-user", "blocked-external", "partial", "failed"];
const confidenceValues = ["high", "medium", "low"];
const annotations = (readOnly = false) => ({ readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: false });
const respond = (result) => ({
  structuredContent: result,
  content: [{ type: "text", text: result.ok ? JSON.stringify(result) : `${result.error.code}: ${result.error.message}` }],
  isError: !result.ok
});
const register = (name, title, description, inputSchema, readOnly, handler) => server.registerTool(
  name,
  { title, description, inputSchema, outputSchema: z.object({ ok: z.boolean() }).passthrough(), annotations: annotations(readOnly) },
  async (input) => respond(await handler(input))
);

const acceptanceCriterion = z.object({ acceptance_id: z.string().min(1), description: z.string().min(1) });
const externalAction = z.object({ action: zEnum(actionValues), target: z.string().min(1), environment: z.string().min(1), request_summary: z.string().min(1).optional() });
const evidenceRecord = z.object({
  evidence_id: z.string().min(1), acceptance_ids: z.array(z.string().min(1)).min(1), type: z.string().min(1),
  result: zEnum(EVIDENCE_RESULTS), artifact: z.string().min(1), artifact_digest: digest,
  command_or_request_id: z.string().min(1), observed_at: z.string().datetime(), producer: z.string().min(1), environment: z.string().min(1),
  supersedes: z.string().nullable().optional(), expires_at: z.string().datetime().nullable().optional(),
  delivery_generation: z.number().int().positive().optional(), subject_digest: digest.optional()
});
const reviewFinding = z.object({
  finding_id: z.string().min(1), severity: zEnum(REVIEW_SEVERITIES), disposition: zEnum(REVIEW_DISPOSITIONS),
  reason: z.string().min(1).optional(), reverified_by: z.string().min(1).optional(), delivery_generation: z.number().int().positive().optional(),
  fixed_point_digest: digest.optional(), review_run_id: z.string().min(1).optional()
});
const actionScope = {
  flow_id: flowId, expected_revision: revision, authorization_id: z.string().min(1).optional(), action: zEnum(actionValues),
  target: z.string().min(1), environment: z.string().min(1), request_summary: z.string().min(1).optional(), external_request_digest: digest.optional()
};

register("start_or_resume_flow", "Start or resume flow", "Start a policy-pinned flow or recover an interrupted one. The controller derives request digests and auto-escalates declared external-action work to strict mode.", {
  flow_id: flowId.optional(), expected_revision: revision.default(0), plan_root: z.string().min(1), plan_target: z.string().min(1),
  flow: zEnum(FLOW_VALUES).default("main"), mode: zEnum(MODE_VALUES).optional(), mode_reason: z.string().min(1).optional(),
  strict_signals: z.array(zEnum(STRICT_ESCALATION_SIGNALS)).default([]), terminal_condition: z.string().min(1).optional(), resume_point: z.string().min(1).optional(),
  scope_digest: digest.optional(), acceptance_criteria: z.array(acceptanceCriterion).default([]), required_evidence_types: z.array(z.string().min(1)).default([]),
  external_actions: z.array(externalAction).default([]), correlation_id: z.string().min(1).optional(), request_summary: z.string().min(1).optional()
}, false, (input) => controller.startOrResumeFlow(input));

register("route_flow", "Route flow", "Select the policy-owned route and optional strict escalation. Route phase order and next state are controller-derived.", {
  flow_id: flowId, expected_revision: revision, chosen_procedure: z.string().min(1), why: z.string().min(1), confidence: zEnum(confidenceValues).default("high"),
  setup_required: z.boolean().default(false), approved_spec: z.boolean().default(false), approved_spec_digest: digest.optional(), confirmed: z.boolean().default(false),
  mode: zEnum(MODE_VALUES).optional(), mode_reason: z.string().min(1).optional(), strict_signals: z.array(zEnum(STRICT_ESCALATION_SIGNALS)).default([]), request_summary: z.string().min(1).optional(), reason: z.string().min(1).optional()
}, false, (input) => controller.routeFlow(input));

const checkpointSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("phase"), flow_id: flowId, expected_revision: revision, phase: zEnum(phaseValues), outcome: zEnum(outcomeValues).default("completed"), artifact_digest: digest.optional(), reason: z.string().min(1), resume_point: z.string().min(1).optional(), request_summary: z.string().min(1).optional() }),
  z.object({ kind: z.literal("scope-change"), flow_id: flowId, expected_revision: revision, scope_digest: digest, reason: z.string().min(1), request_summary: z.string().min(1).optional() }),
  z.object({ kind: z.literal("migrate-policy"), flow_id: flowId, expected_revision: revision, accept_current_policy: z.literal(true), mode: zEnum(MODE_VALUES).optional(), mode_reason: z.string().min(1).optional(), reason: z.string().min(1).optional(), resume_point: z.string().min(1).optional(), request_summary: z.string().min(1).optional() }),
  z.object({ kind: z.literal("resolve-drift"), flow_id: flowId, expected_revision: revision, resolution: z.literal("accept-restored-plan-tree"), reason: z.string().min(1), request_summary: z.string().min(1).optional() })
]);
register("checkpoint_flow", "Checkpoint flow", "Advance, pause, revise scope, explicitly migrate policy, or resolve a restored controlled-state drift.", checkpointSchema, false, (input) => controller.checkpointFlow(input));

const evidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("delivery"), flow_id: flowId, expected_revision: revision, evidence: evidenceRecord, request_summary: z.string().min(1).optional() }),
  z.object({ kind: z.literal("review"), flow_id: flowId, expected_revision: revision, review_findings: z.array(reviewFinding), reason: z.string().min(1).optional(), request_summary: z.string().min(1).optional() })
]);
register("record_evidence", "Record evidence", "Record delivery evidence or review dispositions. Artifact paths are confined to plan_root and their digest is verified before close.", evidenceSchema, false, (input) => controller.recordEvidence(input));

const authorizationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("request"), ...actionScope, authorization_id: z.never().optional(), ttl_ms: z.number().int().positive().max(300000).optional() }),
  z.object({ kind: z.literal("confirm"), ...actionScope, authorization_id: z.string().min(1), confirmation_mode: z.enum(["challenge", "elicitation"]), challenge_code: z.string().min(1).optional(), confirmed_by: z.string().min(1).optional() }),
  z.object({ kind: z.literal("consume"), ...actionScope, authorization_id: z.string().min(1) }),
  z.object({ kind: z.literal("record-result"), ...actionScope, authorization_id: z.string().min(1), reason: z.string().min(1).optional(), result: z.object({ action_result_id: z.string().min(1), outcome: z.enum(["succeeded", "failed"]), observed_at: z.string().datetime(), producer: z.string().min(1), result_digest: digest, artifact: z.string().min(1), artifact_digest: digest, command_or_request_id: z.string().min(1), supersedes: z.string().min(1).optional(), delivery_generation: z.number().int().positive().optional() }) })
]);
register("authorize_external_action", "Authorize external action", "Request, confirm, consume, or record the outcome of one exact external action. Every controlled action remains short-lived, single-use, and fail-closed.", authorizationSchema, false, (input) => {
  const normalized = input.kind === "confirm" ? { ...input, mode: input.confirmation_mode } : input;
  return controller.authorizeExternalAction(normalized);
});

const auditSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("audit"), flow_id: flowId }),
  z.object({ kind: z.literal("recover"), flow_id: flowId, expected_revision: revision, plan_root: z.string().min(1).optional(), plan_target: z.string().min(1).optional(), lease_owner: z.string().min(1).optional(), lease_ms: z.number().int().positive().optional(), request_summary: z.string().min(1).optional() })
]);
register("audit_or_recover_flow", "Audit or recover flow", "Read consistency or reconcile an interrupted journal. Recovery never overwrites unresolved controlled-state drift.", auditSchema, false, (input) => controller.auditOrRecoverFlow(input));

const closeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("close"), flow_id: flowId, expected_revision: revision, terminal_observation: z.object({ evidence_id: z.string().min(1), artifact: z.string().min(1), artifact_digest: digest, observed_at: z.string().datetime(), result: zEnum(EVIDENCE_RESULTS) }).optional(), reason: z.string().min(1).optional(), request_summary: z.string().min(1).optional() }),
  z.object({ kind: z.literal("cancel"), flow_id: flowId, expected_revision: revision, reason: z.string().min(1).optional(), resume_point: z.string().min(1).optional(), request_summary: z.string().min(1).optional() })
]);
register("close_or_cancel_flow", "Close or cancel flow", "Close only when policy evidence and terminal gates pass, or persist an explicit user cancellation without deleting recovery state.", closeSchema, false, (input) => controller.closeOrCancelFlow(input));

const transport = new StdioServerTransport();
await server.connect(transport);

const shutdown = async () => { controller.close(); await server.close(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
