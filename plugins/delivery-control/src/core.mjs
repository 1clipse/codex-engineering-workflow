import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import {
  DEFAULT_AUTH_TTL_MS, DEFAULT_BACKUP_RETENTION, DEFAULT_LEASE_MS, EVIDENCE_RESULTS, EVENT_RULES, FLOW_VALUES,
  LEGACY_END, LEGACY_START, PHASE_LABELS, PHASE_ORDER, PHASE_VALUES, REQUIRED_PHASES_BY_FLOW, SCHEMA_VERSION,
  PHASE_TRANSITIONS, REQUIRED_PHASE_SKIP_EXCEPTIONS, SENSITIVE_ACTIONS, STATE_END, STATE_START, STATUS_TRANSITIONS, STATUS_VALUES
} from "./constants.mjs";

const ok = (value) => ({ ok: true, ...value });
const fail = (code, message, details = {}) => ({ ok: false, error: { code, message, ...details } });
const nowIso = (clock) => new Date(clock()).toISOString();
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
};
export const sha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const requestDigest = (operation, input, fields) => sha256(canonical({
  operation,
  ...Object.fromEntries(fields.map((field) => [field, input[field]]))
}));

function assertString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function contained(root, target) {
  const rootPath = resolve(assertString(root, "plan_root"));
  const targetPath = resolve(assertString(target, "plan_target"));
  const rel = relative(rootPath, targetPath);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return { rootPath, targetPath };
  throw new Error("plan_target must be inside plan_root");
}

function readText(path) {
  return readFileSync(path, "utf8");
}

function fileDigest(path) {
  return sha256(readFileSync(path));
}

function artifactPath(planRoot, artifact) {
  const value = assertString(artifact, "artifact");
  return isAbsolute(value) ? resolve(value) : resolve(planRoot, value);
}

function syncDirectory(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch (error) {
    if (!["EINVAL", "EPERM", "EISDIR"].includes(error.code)) throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function atomicProject(target, content, transactionId) {
  const folder = dirname(target);
  const backupFolder = join(folder, ".delivery-control-backups");
  mkdirSync(backupFolder, { recursive: true });
  const temp = join(folder, `.${transactionId}.delivery-control.tmp`);
  const backup = join(backupFolder, `${basename(target)}.${new Date().toISOString().replaceAll(":", "").replaceAll(".", "")}.${transactionId}.bak`);
  copyFileSync(target, backup);
  const fd = openSync(temp, "wx");
  try {
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, target);
  syncDirectory(folder);
  syncDirectory(backupFolder);
  const backups = readdirSync(backupFolder)
    .filter((name) => name.startsWith(`${basename(target)}.`) && name.endsWith(".bak"))
    .map((name) => ({ name, path: join(backupFolder, name), mtime: statSync(join(backupFolder, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const stale of backups.slice(DEFAULT_BACKUP_RETENTION)) {
    try { unlinkSync(stale.path); } catch {}
  }
  return { backup, temp };
}

function normalizeState(input) {
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
    route: input.route ?? null,
    acceptance_criteria: Array.isArray(input.acceptance_criteria) ? input.acceptance_criteria : [],
    required_evidence_types: Array.isArray(input.required_evidence_types) ? input.required_evidence_types : [],
    external_actions: Array.isArray(input.external_actions) ? input.external_actions : [],
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
  if (!FLOW_VALUES.includes(state.flow)) throw new Error(`unknown flow: ${state.flow}`);
  if (!STATUS_VALUES.includes(state.status)) throw new Error(`unknown status: ${state.status}`);
  if (!PHASE_VALUES.includes(state.current_phase)) throw new Error(`unknown current_phase: ${state.current_phase}`);
  if (state.next_phase !== "none" && !PHASE_VALUES.includes(state.next_phase)) throw new Error(`unknown next_phase: ${state.next_phase}`);
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
    return { finding_id, severity, disposition, reason: finding.reason || null, reverified_by: finding.reverified_by || null };
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
  if (state.terminal_observation !== null) {
    for (const field of ["evidence_id", "artifact", "artifact_digest", "observed_at", "result"]) assertString(state.terminal_observation[field], `terminal observation ${field}`);
    if (!/^sha256:[0-9a-f]{64}$/.test(state.terminal_observation.artifact_digest)) throw new Error("terminal observation artifact_digest must be sha256:<64 lowercase hex>");
  }
  return state;
}

function stateBlock(state) {
  return `${STATE_START}\n\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\`\n${STATE_END}`;
}

function validateTransition(previous, next, event) {
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

function replaceStateBlock(text, state) {
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

function parseLegacyBlock(text, target) {
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

function publicFlow(row) {
  if (!row) return null;
  return {
    flow_id: row.flow_id, revision: row.revision, plan_root: row.plan_root, plan_target: row.plan_target,
    flow: row.flow, status: row.status, current_phase: row.current_phase, next_phase: row.next_phase,
    terminal_condition: row.terminal_condition, resume_point: row.resume_point,
    plan_tree_digest: row.plan_tree_digest, native_plan_digest: row.native_plan_digest,
    plan_sync: row.plan_sync, frozen: Boolean(row.frozen), drift_report: row.drift_report ? JSON.parse(row.drift_report) : null,
    route: row.route_json ? JSON.parse(row.route_json) : null,
    acceptance_criteria: JSON.parse(row.acceptance_json || "[]"),
    required_evidence_types: JSON.parse(row.required_types_json || "[]"),
    external_actions: JSON.parse(row.external_actions_json || "[]"),
    ...JSON.parse(row.gate_json || '{"review_findings":[],"terminal_observation":null}'),
    evidence_records: JSON.parse(row.evidence_json || "[]"),
    authorization_receipts: JSON.parse(row.authorization_receipts_json || "[]"),
    history: JSON.parse(row.history_json || "[]"),
    correlation_id: row.correlation_id, receipt_digest: row.receipt_digest,
    created_at: row.created_at, updated_at: row.updated_at
  };
}

function gateJson(state) {
  return JSON.stringify({ review_findings: state.review_findings || [], terminal_observation: state.terminal_observation || null });
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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL);
      INSERT INTO schema_meta(version) SELECT ${SCHEMA_VERSION} WHERE NOT EXISTS (SELECT 1 FROM schema_meta);
      CREATE TABLE IF NOT EXISTS flows (
        flow_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, plan_root TEXT NOT NULL, plan_target TEXT NOT NULL,
        flow TEXT NOT NULL, status TEXT NOT NULL, current_phase TEXT NOT NULL, next_phase TEXT NOT NULL,
        terminal_condition TEXT NOT NULL, resume_point TEXT NOT NULL, plan_tree_digest TEXT NOT NULL,
        native_plan_digest TEXT, plan_sync TEXT NOT NULL DEFAULT 'pending', frozen INTEGER NOT NULL DEFAULT 0,
        drift_report TEXT, route_json TEXT, acceptance_json TEXT NOT NULL DEFAULT '[]', required_types_json TEXT NOT NULL DEFAULT '[]',
        external_actions_json TEXT NOT NULL DEFAULT '[]', gate_json TEXT NOT NULL DEFAULT '{"review_findings":[],"terminal_observation":null}', correlation_id TEXT, receipt_digest TEXT,
        evidence_json TEXT NOT NULL DEFAULT '[]', authorization_receipts_json TEXT NOT NULL DEFAULT '[]', history_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, revision INTEGER NOT NULL, event TEXT NOT NULL,
        request_digest TEXT NOT NULL, previous_state TEXT, new_state TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_transactions (
        transaction_id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, expected_revision INTEGER NOT NULL, target_revision INTEGER NOT NULL,
        stage TEXT NOT NULL, old_digest TEXT NOT NULL, new_digest TEXT NOT NULL, old_state TEXT NOT NULL, new_state TEXT NOT NULL,
        request_digest TEXT NOT NULL, reason TEXT NOT NULL, backup_path TEXT, temp_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS leases (
        flow_id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS evidence (
        evidence_id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, acceptance_ids TEXT NOT NULL, type TEXT NOT NULL, result TEXT NOT NULL,
        artifact TEXT NOT NULL, artifact_digest TEXT NOT NULL, command_or_request_id TEXT NOT NULL, observed_at TEXT NOT NULL,
        producer TEXT NOT NULL, environment TEXT NOT NULL, supersedes TEXT, expires_at TEXT, legacy_unverified INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS authorizations (
        authorization_id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, environment TEXT NOT NULL,
        request_digest TEXT NOT NULL, control_request_digest TEXT NOT NULL DEFAULT '', expires_at TEXT NOT NULL, nonce TEXT NOT NULL UNIQUE, challenge_digest TEXT NOT NULL,
        confirmed_by TEXT, confirmed_at TEXT, confirmed_request_digest TEXT, consumed_at TEXT, consumed_request_digest TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS native_plan_sync (
        projection_id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, flow_revision INTEGER NOT NULL, projection_revision INTEGER NOT NULL,
        plan_json TEXT NOT NULL, digest TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, confirmed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS metric_aggregates (
        metric TEXT NOT NULL, dimension TEXT NOT NULL, value INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(metric, dimension)
      );
      CREATE INDEX IF NOT EXISTS idx_events_flow ON events(flow_id, revision);
      CREATE INDEX IF NOT EXISTS idx_pending_flow ON pending_transactions(flow_id, stage);
      CREATE INDEX IF NOT EXISTS idx_evidence_flow ON evidence(flow_id);
      CREATE INDEX IF NOT EXISTS idx_auth_flow ON authorizations(flow_id);
    `);
    const columns = new Set(this.db.prepare("PRAGMA table_info(flows)").all().map((column) => column.name));
    for (const [name, definition] of [["evidence_json", "TEXT NOT NULL DEFAULT '[]'"], ["authorization_receipts_json", "TEXT NOT NULL DEFAULT '[]'"], ["history_json", "TEXT NOT NULL DEFAULT '[]'"], ["gate_json", `TEXT NOT NULL DEFAULT '{"review_findings":[],"terminal_observation":null}'`]]) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE flows ADD COLUMN ${name} ${definition}`);
    }
    const version = this.db.prepare("SELECT version FROM schema_meta").get().version;
    if (version > SCHEMA_VERSION) throw new Error(`Unsupported database schema: ${version}`);
    if (version < 2) {
      const authColumns = new Set(this.db.prepare("PRAGMA table_info(authorizations)").all().map((column) => column.name));
      for (const [name, definition] of [
        ["control_request_digest", "TEXT NOT NULL DEFAULT ''"],
        ["confirmed_request_digest", "TEXT"],
        ["consumed_request_digest", "TEXT"]
      ]) if (!authColumns.has(name)) this.db.exec(`ALTER TABLE authorizations ADD COLUMN ${name} ${definition}`);
      this.db.prepare("UPDATE schema_meta SET version=?").run(2);
    }
    const migratedVersion = this.db.prepare("SELECT version FROM schema_meta").get().version;
    if (migratedVersion !== SCHEMA_VERSION) throw new Error(`Unsupported database schema: ${migratedVersion}`);
  }

  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = fn(); this.db.exec("COMMIT"); return value; }
    catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }

  row(flowId) { return this.db.prepare("SELECT * FROM flows WHERE flow_id=?").get(flowId); }

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
        acceptance_criteria: input.acceptance_criteria || [], required_evidence_types: input.required_evidence_types || [],
        external_actions: input.external_actions || [], correlation_id: input.correlation_id || null, plan_sync: "pending"
      });
      const projected = replaceStateBlock(current, state);
      const txId = randomUUID();
      atomicProject(targetPath, projected, txId);
      const digest = fileDigest(targetPath);
      const at = nowIso(this.clock);
      this.transaction(() => {
        this.db.prepare(`INSERT INTO flows(flow_id,revision,plan_root,plan_target,flow,status,current_phase,next_phase,terminal_condition,resume_point,
        plan_tree_digest,native_plan_digest,plan_sync,frozen,drift_report,route_json,acceptance_json,required_types_json,external_actions_json,gate_json,
          correlation_id,receipt_digest,evidence_json,authorization_receipts_json,history_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          flowId, state.revision, rootPath, targetPath, state.flow, state.status, state.current_phase, state.next_phase,
          state.terminal_condition, state.resume_point, digest, state.native_plan_digest, state.plan_sync, 0, null, state.route ? JSON.stringify(state.route) : null,
          JSON.stringify(state.acceptance_criteria), JSON.stringify(state.required_evidence_types), JSON.stringify(state.external_actions), gateJson(state),
          state.correlation_id, state.receipt_digest, JSON.stringify(state.evidence_records), JSON.stringify(state.authorization_receipts), JSON.stringify(state.history), at, at);
        this.db.prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?)").run(randomUUID(), flowId, state.revision, "initialized", input.request_digest, null, JSON.stringify(state), "flow initialized", at);
        this.metric("flow", "initialized");
      });
      return ok({ flow: publicFlow(this.row(flowId)), imported_legacy: Boolean(imported) });
    } catch (error) { return fail(error.code || "initialize_failed", error.message); }
  }

  inspectFlow(flowId) {
    const row = this.row(flowId);
    return row ? ok({ flow: publicFlow(row) }) : fail("flow_not_found", `unknown flow: ${flowId}`);
  }

  startOrResumeFlow(input) {
    if (input.flow_id && this.row(input.flow_id)) {
      return this.recoverFlow({ flow_id: input.flow_id, expected_revision: input.expected_revision, request_digest: input.request_digest, plan_root: input.plan_root, plan_target: input.plan_target });
    }
    return this.initializeFlow(input);
  }

  advanceFlow(input) {
    const committed = this.commitTransition(input);
    if (!committed.ok) return committed;
    const projection = this.projectNativePlan({ flow_id: input.flow_id, expected_revision: committed.flow.revision, request_digest: requestDigest("project_native_plan", { ...input, expected_revision: committed.flow.revision }, ["flow_id", "expected_revision"]) });
    return ok({ flow: projection.ok ? projection.flow || committed.flow : committed.flow, native_plan_projection: projection.ok ? projection : { ok: false, error: projection.error } });
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
    const skipped = [...new Set(input.skipped_phases || [])];
    for (const phase of skipped) if (!PHASE_ORDER.includes(phase) || phase === "route" || phase === "close") return fail("invalid_skipped_phase", `cannot skip phase: ${phase}`);
    if (input.setup_required !== true && !skipped.includes("setup")) skipped.unshift("setup");
    const required = REQUIRED_PHASES_BY_FLOW[row.flow] || [];
    const invalidRequiredSkips = required.filter((phase) => skipped.includes(phase) && !(REQUIRED_PHASE_SKIP_EXCEPTIONS[phase] && input.approved_spec === true));
    if (invalidRequiredSkips.length) return fail("required_phase_skipped", `required phases cannot be skipped: ${invalidRequiredSkips.join(", ")}`, { phases: invalidRequiredSkips });
    const route = {
      chosen_procedure: assertString(input.chosen_procedure, "chosen_procedure"),
      why: assertString(input.why, "why"), skipped_phases: skipped,
      confidence: input.confidence || "high", approved_spec: input.approved_spec === true, selected_at: nowIso(this.clock)
    };
    const nextPhase = PHASE_ORDER.slice(1).find((phase) => !skipped.includes(phase)) || "close";
    const awaiting = route.confidence === "low" && input.confirmed !== true;
    const patch = { route, status: awaiting ? "awaiting-user" : "active", next_phase: awaiting ? "route" : nextPhase };
    if (awaiting) patch.resume_point = "Route confidence is low; user must confirm the selected route";
    return this.commitTransition({ ...input, event: "route-selected", reason: input.reason || route.why, patch });
  }

  proposeTransition(input) {
    try {
      const row = this.row(input.flow_id);
      if (!row) return fail("flow_not_found", `unknown flow: ${input.flow_id}`);
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
        this.acquireLease(row.flow_id, owner, input.lease_ms);
        oldText = readText(row.plan_target);
        const actualDigest = sha256(Buffer.from(oldText));
        if (actualDigest !== row.plan_tree_digest) throw Object.assign(new Error("Plan Tree changed outside delivery-control"), { code: "plan_tree_drift", expected: row.plan_tree_digest, actual: actualDigest });
        const state = normalizeState({ ...proposal.state, plan_target: row.plan_target });
        state.history = [...state.history, { event_id: randomUUID(), revision: state.revision, event: proposal.event || "advance", reason: proposal.reason, request_digest: proposal.request_digest, previous_status: row.status, previous_phase: row.current_phase, new_status: state.status, new_phase: state.current_phase, observed_at: nowIso(this.clock) }];
        proposal.state = state;
        newText = replaceStateBlock(oldText, state);
        txId = randomUUID();
        this.db.prepare(`INSERT INTO pending_transactions(transaction_id,flow_id,expected_revision,target_revision,stage,old_digest,new_digest,
          old_state,new_state,request_digest,reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          txId, row.flow_id, row.revision, state.revision, "prepared", row.plan_tree_digest, sha256(Buffer.from(newText)),
          JSON.stringify(publicFlow(row)), JSON.stringify(state), proposal.request_digest, proposal.reason, nowIso(this.clock), nowIso(this.clock));
      });
      this.fault("after_prepare", { transaction_id: txId });
      const paths = atomicProject(row.plan_target, newText, txId);
      this.fault("after_project", { transaction_id: txId });
      this.transaction(() => {
        const current = this.row(row.flow_id);
        if (current.revision !== proposal.expected_revision) throw Object.assign(new Error("revision changed during projection"), { code: "revision_conflict" });
        const digest = fileDigest(row.plan_target);
        const expectedDigest = sha256(Buffer.from(newText));
        if (digest !== expectedDigest) throw Object.assign(new Error("projected Plan Tree digest mismatch"), { code: "projection_digest_mismatch" });
        const state = normalizeState(proposal.state);
        this.db.prepare(`UPDATE pending_transactions SET stage='projected',backup_path=?,temp_path=?,updated_at=? WHERE transaction_id=?`).run(paths.backup, paths.temp, nowIso(this.clock), txId);
        this.db.prepare(`UPDATE flows SET revision=?,flow=?,status=?,current_phase=?,next_phase=?,terminal_condition=?,resume_point=?,plan_tree_digest=?,
          native_plan_digest=?,plan_sync=?,route_json=?,acceptance_json=?,required_types_json=?,external_actions_json=?,gate_json=?,correlation_id=?,receipt_digest=?,evidence_json=?,authorization_receipts_json=?,history_json=?,updated_at=? WHERE flow_id=?`).run(
          state.revision, state.flow, state.status, state.current_phase, state.next_phase, state.terminal_condition, state.resume_point,
          digest, state.native_plan_digest, state.plan_sync, state.route ? JSON.stringify(state.route) : null, JSON.stringify(state.acceptance_criteria),
          JSON.stringify(state.required_evidence_types), JSON.stringify(state.external_actions), gateJson(state), state.correlation_id, state.receipt_digest,
          JSON.stringify(state.evidence_records), JSON.stringify(state.authorization_receipts), JSON.stringify(state.history), nowIso(this.clock), row.flow_id);
        this.db.prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?)").run(randomUUID(), row.flow_id, state.revision, proposal.event || "advance", proposal.request_digest, JSON.stringify(publicFlow(row)), JSON.stringify(state), proposal.reason, nowIso(this.clock));
        this.db.prepare("UPDATE pending_transactions SET stage='committed',updated_at=? WHERE transaction_id=?").run(nowIso(this.clock), txId);
        this.db.prepare("DELETE FROM leases WHERE flow_id=? AND owner=?").run(row.flow_id, owner);
        this.metric("transition", proposal.event || "advance");
      });
      this.fault("after_commit", { transaction_id: txId });
      return ok({ transaction_id: txId, flow: publicFlow(this.row(row.flow_id)) });
    } catch (error) {
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
        const state = parseStateBlock(text);
        if (state.flow_id !== input.flow_id) return fail("flow_identity_mismatch", "Plan Tree flow_id does not match requested flow");
        const at = nowIso(this.clock);
        this.transaction(() => this.db.prepare(`INSERT INTO flows(flow_id,revision,plan_root,plan_target,flow,status,current_phase,next_phase,terminal_condition,resume_point,
          plan_tree_digest,native_plan_digest,plan_sync,frozen,drift_report,route_json,acceptance_json,required_types_json,external_actions_json,gate_json,
          correlation_id,receipt_digest,evidence_json,authorization_receipts_json,history_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          state.flow_id, state.revision, rootPath, targetPath, state.flow, state.status, state.current_phase, state.next_phase,
          state.terminal_condition, state.resume_point, fileDigest(targetPath), state.native_plan_digest, state.plan_sync, 0, null,
          state.route ? JSON.stringify(state.route) : null, JSON.stringify(state.acceptance_criteria), JSON.stringify(state.required_evidence_types),
          JSON.stringify(state.external_actions), gateJson(state), state.correlation_id, state.receipt_digest, JSON.stringify(state.evidence_records), JSON.stringify(state.authorization_receipts), JSON.stringify(state.history), at, at));
        this.syncEvidenceCache(state.flow_id, state.evidence_records);
        this.rebuildMetricsCache(state.history);
        row = this.row(input.flow_id);
        return ok({ action: "rebuilt-from-plan-tree", flow: publicFlow(row) });
      }
      if (row.revision !== input.expected_revision) return fail("revision_conflict", "expected_revision is stale", { actual: row.revision });
      if (!/^sha256:[0-9a-f]{64}$/.test(input.request_digest || "")) return fail("invalid_request_digest", "request_digest must be sha256:<64 lowercase hex>");
      const recoveryOwner = input.lease_owner || `recovery:${randomUUID()}`;
      try { this.transaction(() => this.acquireLease(row.flow_id, recoveryOwner, input.lease_ms)); }
      catch (error) { return fail(error.code || "lease_conflict", error.message); }
      const pending = this.db.prepare("SELECT * FROM pending_transactions WHERE flow_id=? AND stage IN ('prepared','projected') ORDER BY created_at").all(input.flow_id);
      const actions = [];
      for (const tx of pending) {
        const actual = fileDigest(row.plan_target);
        if (actual === tx.new_digest) {
          const state = normalizeState(JSON.parse(tx.new_state));
          this.transaction(() => {
            this.db.prepare(`UPDATE flows SET revision=?,flow=?,status=?,current_phase=?,next_phase=?,terminal_condition=?,resume_point=?,plan_tree_digest=?,
              native_plan_digest=?,plan_sync=?,route_json=?,acceptance_json=?,required_types_json=?,external_actions_json=?,gate_json=?,correlation_id=?,receipt_digest=?,evidence_json=?,authorization_receipts_json=?,history_json=?,updated_at=? WHERE flow_id=?`).run(
              state.revision, state.flow, state.status, state.current_phase, state.next_phase, state.terminal_condition, state.resume_point,
              actual, state.native_plan_digest, state.plan_sync, state.route ? JSON.stringify(state.route) : null, JSON.stringify(state.acceptance_criteria), JSON.stringify(state.required_evidence_types),
              JSON.stringify(state.external_actions), gateJson(state), state.correlation_id, state.receipt_digest, JSON.stringify(state.evidence_records), JSON.stringify(state.authorization_receipts), JSON.stringify(state.history), nowIso(this.clock), row.flow_id);
            this.syncEvidenceCache(state.flow_id, state.evidence_records);
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
        const actual = fileDigest(row.plan_target);
        if (actual !== row.plan_tree_digest) {
          const report = { detected_at: nowIso(this.clock), expected_digest: row.plan_tree_digest, actual_digest: actual, source: "recover_flow" };
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
      if (row.revision !== input.expected_revision) return fail("revision_conflict", "expected_revision is stale", { actual: row.revision });
      if (!/^sha256:[0-9a-f]{64}$/.test(input.request_digest || "")) return fail("invalid_request_digest", "request_digest must be sha256:<64 lowercase hex>");
      if (input.resolution !== "accept-restored-plan-tree") return fail("resolution_required", "explicit restored Plan Tree resolution is required");
      assertString(input.reason, "reason");
      const actual = fileDigest(row.plan_target);
      if (actual !== row.plan_tree_digest) return fail("plan_tree_drift", "Plan Tree still differs from the controller digest", { expected: row.plan_tree_digest, actual });
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
      const actual = fileDigest(row.plan_target);
      const pending = this.db.prepare("SELECT transaction_id,stage,old_digest,new_digest FROM pending_transactions WHERE flow_id=? AND stage IN ('prepared','projected')").all(flowId);
      return ok({ consistent: actual === row.plan_tree_digest && pending.length === 0 && !row.frozen, expected_digest: row.plan_tree_digest, actual_digest: actual, pending, frozen: Boolean(row.frozen), drift_report: row.drift_report ? JSON.parse(row.drift_report) : null });
    } catch (error) { return fail("consistency_check_failed", error.message); }
  }

  projectNativePlan(input) {
    const row = this.row(input.flow_id);
    if (!row) return fail("flow_not_found", `unknown flow: ${input.flow_id}`);
    if (row.revision !== input.expected_revision) return fail("revision_conflict", "expected_revision is stale", { actual: row.revision });
    if (!/^sha256:[0-9a-f]{64}$/.test(input.request_digest || "")) return fail("invalid_request_digest", "request_digest must be sha256:<64 lowercase hex>");
    if (row.frozen) return fail("flow_frozen", "flow is frozen");
    const route = row.route_json ? JSON.parse(row.route_json) : null;
    const skipped = new Set(route?.skipped_phases || []);
    const start = PHASE_ORDER.indexOf(row.current_phase);
    const phases = PHASE_ORDER.slice(Math.max(start, 0)).filter((phase) => phase === row.current_phase || phase === row.next_phase || !skipped.has(phase));
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
    if (!projection) return fail("projection_not_found", "native Plan projection was not found");
    const row = this.row(input.flow_id);
    if (row.revision !== input.expected_revision) return fail("revision_conflict", "expected_revision is stale", { actual: row.revision });
    if (!/^sha256:[0-9a-f]{64}$/.test(input.request_digest || "")) return fail("invalid_request_digest", "request_digest must be sha256:<64 lowercase hex>");
    if (row.revision !== projection.flow_revision || input.projection_revision !== projection.projection_revision) return fail("stale_projection", "native Plan projection is stale");
    const actualDigest = sha256(canonical({ flow_id: row.flow_id, flow_revision: row.revision, projection_revision: projection.projection_revision, steps: input.applied_steps }));
    if (actualDigest !== projection.digest) return fail("native_plan_mismatch", "applied native Plan does not match projection", { expected_digest: projection.digest, actual_digest: actualDigest });
    const committed = this.commitTransition({ flow_id: row.flow_id, expected_revision: row.revision, request_digest: input.request_digest, event: "native-plan-confirmed", reason: `confirm native Plan projection ${projection.projection_revision}`, patch: { plan_sync: "confirmed", native_plan_digest: actualDigest } });
    if (!committed.ok) return committed;
    this.transaction(() => {
      this.db.prepare("UPDATE native_plan_sync SET status='confirmed',confirmed_at=? WHERE projection_id=?").run(nowIso(this.clock), projection.projection_id);
    });
    return ok({ confirmed: true, digest: actualDigest, flow: publicFlow(this.row(row.flow_id)) });
  }

  markNativePlanUnavailable(input) {
    const row = this.row(input.flow_id);
    if (!row) return fail("flow_not_found", `unknown flow: ${input.flow_id}`);
    if (row.revision !== input.expected_revision) return fail("revision_conflict", "expected_revision is stale", { actual: row.revision });
    if (!/^sha256:[0-9a-f]{64}$/.test(input.request_digest || "")) return fail("invalid_request_digest", "request_digest must be sha256:<64 lowercase hex>");
    return this.commitTransition({ flow_id: row.flow_id, expected_revision: row.revision, request_digest: input.request_digest, event: "native-plan-unavailable", reason: "Codex update_plan unavailable; persist handoff", patch: { plan_sync: "unavailable", resume_point: input.handoff || row.resume_point } });
  }

  addEvidence(input) {
    try {
      const row = this.row(input.flow_id);
      if (!row) return fail("flow_not_found", `unknown flow: ${input.flow_id}`);
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
      const record = { ...evidence, artifact: artifactPath(row.plan_root, evidence.artifact), acceptance_ids: [...new Set(evidence.acceptance_ids)], supersedes: evidence.supersedes || null, expires_at: evidence.expires_at || null, legacy_unverified: false };
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
    const valid = [];
    const invalid = [];
    const ignored = [];
    for (const item of records) {
      let reason = null;
      if (superseded.has(item.evidence_id)) { ignored.push({ ...item, reason: "superseded" }); continue; }
      if (item.legacy_unverified) reason = "legacy-unverified";
      else if (item.expires_at && Date.parse(item.expires_at) <= this.clock()) reason = "expired";
      else if (!EVIDENCE_RESULTS.includes(item.result)) reason = "failed-result";
      const artifact = artifactPath(row.plan_root, item.artifact);
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
    const insert = this.db.prepare("INSERT INTO evidence VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    for (const evidence of records) insert.run(evidence.evidence_id, flowId, JSON.stringify(evidence.acceptance_ids), evidence.type, evidence.result, evidence.artifact, evidence.artifact_digest, evidence.command_or_request_id, evidence.observed_at, evidence.producer, evidence.environment, evidence.supersedes || null, evidence.expires_at || null, evidence.legacy_unverified ? 1 : 0);
  }

  rebuildMetricsCache(history) {
    this.db.prepare("DELETE FROM metric_aggregates").run();
    for (const item of history || []) this.metric("transition", item.event || "unknown");
  }

  requestAuthorization(input) {
    try {
      const row = this.row(input.flow_id);
      if (!row) return fail("flow_not_found", `unknown flow: ${input.flow_id}`);
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
         confirmed_by,confirmed_at,confirmed_request_digest,consumed_at,consumed_request_digest,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        authorizationId, row.flow_id, input.action, input.target, input.environment, input.request_digest, controlDigest, expiresAt,
        nonce, sha256(challenge), null, null, null, null, null, nowIso(this.clock)));
      return ok({ authorization_id: authorizationId, expires_at: expiresAt, control_request_digest: controlDigest, confirmation: { mode: input.elicitation_supported ? "elicitation" : "challenge", challenge_code: challenge, prompt: `Authorize ${input.action} on ${input.target} in ${input.environment}` } });
    } catch (error) { return fail("authorization_request_failed", error.message); }
  }

  confirmAuthorization(input) {
    const flow = this.row(input.flow_id);
    if (!flow) return fail("flow_not_found", `unknown flow: ${input.flow_id}`);
    if (flow.revision !== input.expected_revision) return fail("revision_conflict", "expected_revision is stale", { actual: flow.revision });
    if (!/^sha256:[0-9a-f]{64}$/.test(input.request_digest || "")) return fail("invalid_request_digest", "request_digest must be sha256:<64 lowercase hex>");
    const auth = this.db.prepare("SELECT * FROM authorizations WHERE authorization_id=? AND flow_id=?").get(input.authorization_id, input.flow_id);
    if (!auth) return fail("authorization_not_found", "authorization request not found");
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
    if (flow.revision !== input.expected_revision) return fail("revision_conflict", "expected_revision is stale", { actual: flow.revision });
    const existingReceipts = JSON.parse(flow.authorization_receipts_json || "[]");
    if (existingReceipts.some((receipt) => receipt.authorization_id === input.authorization_id)) {
      this.transaction(() => this.db.prepare("UPDATE authorizations SET consumed_at=COALESCE(consumed_at,?),consumed_request_digest=COALESCE(consumed_request_digest,?) WHERE authorization_id=?").run(nowIso(this.clock), input.control_request_digest || requestDigest("consume_authorization", input, ["flow_id", "expected_revision", "authorization_id", "action", "target", "environment", "request_digest"]), input.authorization_id));
      return fail("authorization_replayed", "authorization has already been consumed");
    }
    const auth = this.db.prepare("SELECT * FROM authorizations WHERE authorization_id=? AND flow_id=?").get(input.authorization_id, input.flow_id);
    if (!auth) return fail("authorization_not_found", "authorization request not found");
    if (!auth.confirmed_at) return fail("authorization_unconfirmed", "authorization has not been confirmed");
    if (auth.consumed_at) return fail("authorization_replayed", "authorization has already been consumed");
    if (Date.parse(auth.expires_at) <= this.clock()) return fail("authorization_expired", "authorization expired");
    for (const field of ["action", "target", "environment", "request_digest"]) if (input[field] !== auth[field]) return fail("authorization_scope_mismatch", `${field} does not match authorization scope`);
    const consumedAt = nowIso(this.clock);
    const controlDigest = input.control_request_digest || requestDigest("consume_authorization", input, ["flow_id", "expected_revision", "authorization_id", "action", "target", "environment", "request_digest"]);
    const receipt = { authorization_id: auth.authorization_id, flow_id: auth.flow_id, action: auth.action, target: auth.target, environment: auth.environment, request_digest: auth.request_digest, control_request_digest: controlDigest, confirmed_by: auth.confirmed_by, confirmed_at: auth.confirmed_at, consumed_at: consumedAt };
    const receipts = JSON.parse(flow.authorization_receipts_json || "[]");
    const committed = this.commitTransition({ flow_id: flow.flow_id, expected_revision: flow.revision, request_digest: controlDigest, event: "authorization-consumed", reason: `consume authorization ${auth.authorization_id}`, patch: { authorization_receipts: [...receipts, receipt] } });
    if (!committed.ok) return committed;
    let changed;
    this.transaction(() => { changed = this.db.prepare("UPDATE authorizations SET consumed_at=?,consumed_request_digest=? WHERE authorization_id=? AND consumed_at IS NULL").run(consumedAt, controlDigest, auth.authorization_id).changes; });
    if (changed !== 1) return fail("authorization_replayed", "authorization has already been consumed");
    return ok({ receipt, flow: committed.flow });
  }

  closeFlow(input) {
    const row = this.row(input.flow_id);
    if (!row) return fail("flow_not_found", `unknown flow: ${input.flow_id}`);
    if (row.revision !== input.expected_revision) return fail("revision_conflict", "expected_revision is stale", { actual: row.revision });
    if (!/^sha256:[0-9a-f]{64}$/.test(input.request_digest || "")) return fail("invalid_request_digest", "request_digest must be sha256:<64 lowercase hex>");
    const consistency = this.auditConsistency(row.flow_id);
    const evidence = this.validateEvidence({ flow_id: row.flow_id });
    const unmet = [...(evidence.ok ? evidence.unmet_criteria : [{ kind: "evidence-validation", error: evidence.error }])];
    if (!consistency.ok || !consistency.consistent) unmet.push({ kind: "consistency", details: consistency });
    if (row.plan_sync !== "confirmed" && row.plan_sync !== "unavailable") unmet.push({ kind: "native-plan", status: row.plan_sync });
    const requiredActions = JSON.parse(row.external_actions_json || "[]");
    const receipts = JSON.parse(row.authorization_receipts_json || "[]");
    for (const action of requiredActions) {
      const found = action.request_digest && receipts.find((receipt) => receipt.action === action.action && receipt.target === action.target && receipt.environment === action.environment && receipt.request_digest === action.request_digest && receipt.consumed_at);
      if (!action.request_digest) unmet.push({ kind: "authorization-scope", action, reason: "external action has no request_digest" });
      else if (!found) unmet.push({ kind: "authorization", action });
    }
    const gates = JSON.parse(row.gate_json || '{"review_findings":[],"terminal_observation":null}');
    const rawObservation = input.terminal_observation || gates.terminal_observation;
    const observation = rawObservation ? { ...rawObservation, artifact: artifactPath(row.plan_root, rawObservation.artifact) } : null;
    if (!observation) unmet.push({ kind: "terminal-condition", terminal_condition: row.terminal_condition, reason: "terminal_observation evidence is required" });
    else {
      const terminalEvidence = (evidence.evidence || []).find((item) => item.evidence_id === observation.evidence_id && item.artifact === observation.artifact && item.artifact_digest === observation.artifact_digest);
      if (!terminalEvidence) unmet.push({ kind: "terminal-observation-evidence", evidence_id: observation.evidence_id });
    }
    for (const finding of gates.review_findings || []) {
      if (finding.disposition === "open") unmet.push({ kind: "review-finding", finding_id: finding.finding_id, severity: finding.severity });
      if (["P0", "P1"].includes(finding.severity) && (finding.disposition !== "fixed" || !finding.reverified_by)) unmet.push({ kind: "review-reverification", finding_id: finding.finding_id, disposition: finding.disposition });
    }
    if (unmet.length || (evidence.ok && evidence.invalid_evidence.length)) return fail("completion_gate_failed", "flow cannot close until every gate passes", { unmet_criteria: unmet, invalid_evidence: evidence.ok ? evidence.invalid_evidence : [] });
    return this.commitTransition({ flow_id: row.flow_id, expected_revision: row.revision, event: "terminal-verified", reason: input.reason || "terminal condition and all delivery gates verified", request_digest: input.request_digest, patch: { status: "complete", current_phase: "close", next_phase: "none", terminal_observation: observation, resume_point: "Terminal evidence verified; no remaining work" } });
  }

  cancelFlow(input) {
    return this.commitTransition({ ...input, event: "user-cancelled", reason: input.reason || "cancelled by user", patch: { ...(input.patch || {}), status: "cancelled", next_phase: "none" } });
  }

  getMetrics() {
    const rows = this.db.prepare("SELECT metric,dimension,value FROM metric_aggregates ORDER BY metric,dimension").all();
    return ok({ metrics: rows, privacy: "aggregate counts only; prompts, credentials, paths, and payloads are excluded" });
  }
}
