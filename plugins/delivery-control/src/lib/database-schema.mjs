import { SCHEMA_VERSION } from "../constants.mjs";
import { sha256 } from "./primitives.mjs";

export function migrateDatabase(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL);
    INSERT INTO schema_meta(version) SELECT ${SCHEMA_VERSION} WHERE NOT EXISTS (SELECT 1 FROM schema_meta);
    CREATE TABLE IF NOT EXISTS flows (
      flow_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, plan_root TEXT NOT NULL, plan_target TEXT NOT NULL,
      flow TEXT NOT NULL, status TEXT NOT NULL, current_phase TEXT NOT NULL, next_phase TEXT NOT NULL,
      terminal_condition TEXT NOT NULL, resume_point TEXT NOT NULL, plan_tree_digest TEXT NOT NULL,
      state_digest TEXT, mode TEXT NOT NULL DEFAULT 'legacy', mode_reason TEXT NOT NULL DEFAULT 'Imported before policy pinning',
      policy_id TEXT NOT NULL DEFAULT 'legacy-unverified', policy_version TEXT NOT NULL DEFAULT 'legacy', policy_digest TEXT,
      native_plan_digest TEXT, plan_sync TEXT NOT NULL DEFAULT 'pending', frozen INTEGER NOT NULL DEFAULT 0,
      drift_report TEXT, route_json TEXT, acceptance_json TEXT NOT NULL DEFAULT '[]', required_types_json TEXT NOT NULL DEFAULT '[]',
      external_actions_json TEXT NOT NULL DEFAULT '[]', gate_json TEXT NOT NULL DEFAULT '{"review_findings":[],"terminal_observation":null}', correlation_id TEXT, receipt_digest TEXT,
      external_action_results_json TEXT NOT NULL DEFAULT '[]',
      delivery_generation INTEGER NOT NULL DEFAULT 1, scope_digest TEXT, fixed_point_json TEXT NOT NULL DEFAULT '{"generation":1,"spec_digest":null,"implementation_digest":null,"review_digest":null}',
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
    CREATE TABLE IF NOT EXISTS leases (flow_id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS evidence (
      evidence_id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, acceptance_ids TEXT NOT NULL, type TEXT NOT NULL, result TEXT NOT NULL,
      artifact TEXT NOT NULL, artifact_digest TEXT NOT NULL, command_or_request_id TEXT NOT NULL, observed_at TEXT NOT NULL,
      producer TEXT NOT NULL, environment TEXT NOT NULL, supersedes TEXT, expires_at TEXT, legacy_unverified INTEGER NOT NULL DEFAULT 0,
      delivery_generation INTEGER NOT NULL DEFAULT 1, subject_digest TEXT
    );
    CREATE TABLE IF NOT EXISTS authorizations (
      authorization_id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, environment TEXT NOT NULL,
      request_digest TEXT NOT NULL, control_request_digest TEXT NOT NULL DEFAULT '', expires_at TEXT NOT NULL, nonce TEXT NOT NULL UNIQUE, challenge_digest TEXT NOT NULL,
      confirmed_by TEXT, confirmed_at TEXT, confirmed_request_digest TEXT, consumed_at TEXT, consumed_request_digest TEXT, created_at TEXT NOT NULL,
      delivery_generation INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS external_action_results (
      action_result_id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, authorization_id TEXT NOT NULL, action TEXT NOT NULL,
      target TEXT NOT NULL, environment TEXT NOT NULL, action_request_digest TEXT NOT NULL, outcome TEXT NOT NULL,
      observed_at TEXT NOT NULL, producer TEXT NOT NULL, result_digest TEXT NOT NULL, supersedes TEXT, delivery_generation INTEGER NOT NULL,
      artifact TEXT, artifact_digest TEXT, command_or_request_id TEXT, legacy_unverified INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS native_plan_sync (
      projection_id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, flow_revision INTEGER NOT NULL, projection_revision INTEGER NOT NULL,
      plan_json TEXT NOT NULL, digest TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, confirmed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS metric_aggregates (metric TEXT NOT NULL, dimension TEXT NOT NULL, value INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(metric, dimension));
    CREATE INDEX IF NOT EXISTS idx_events_flow ON events(flow_id, revision);
    CREATE INDEX IF NOT EXISTS idx_pending_flow ON pending_transactions(flow_id, stage);
    CREATE INDEX IF NOT EXISTS idx_evidence_flow ON evidence(flow_id);
    CREATE INDEX IF NOT EXISTS idx_auth_flow ON authorizations(flow_id);
  `);
  const columns = new Set(db.prepare("PRAGMA table_info(flows)").all().map((column) => column.name));
  for (const [name, definition] of [["evidence_json", "TEXT NOT NULL DEFAULT '[]'"], ["authorization_receipts_json", "TEXT NOT NULL DEFAULT '[]'"], ["history_json", "TEXT NOT NULL DEFAULT '[]'"], ["gate_json", `TEXT NOT NULL DEFAULT '{"review_findings":[],"terminal_observation":null}'`], ["delivery_generation", "INTEGER NOT NULL DEFAULT 1"], ["scope_digest", "TEXT"], ["fixed_point_json", `TEXT NOT NULL DEFAULT '{"generation":1,"spec_digest":null,"implementation_digest":null,"review_digest":null}'`], ["external_action_results_json", "TEXT NOT NULL DEFAULT '[]'"]]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE flows ADD COLUMN ${name} ${definition}`);
  }
  const version = db.prepare("SELECT version FROM schema_meta").get().version;
  if (version > SCHEMA_VERSION) throw new Error(`Unsupported database schema: ${version}`);
  if (version < 2) {
    const authColumns = new Set(db.prepare("PRAGMA table_info(authorizations)").all().map((column) => column.name));
    for (const [name, definition] of [["control_request_digest", "TEXT NOT NULL DEFAULT ''"], ["confirmed_request_digest", "TEXT"], ["consumed_request_digest", "TEXT"]]) {
      if (!authColumns.has(name)) db.exec(`ALTER TABLE authorizations ADD COLUMN ${name} ${definition}`);
    }
  }
  if (version < 3) {
    const evidenceColumns = new Set(db.prepare("PRAGMA table_info(evidence)").all().map((column) => column.name));
    if (!evidenceColumns.has("delivery_generation")) db.exec("ALTER TABLE evidence ADD COLUMN delivery_generation INTEGER NOT NULL DEFAULT 1");
    if (!evidenceColumns.has("subject_digest")) db.exec("ALTER TABLE evidence ADD COLUMN subject_digest TEXT");
    db.prepare("UPDATE flows SET scope_digest=COALESCE(scope_digest, ?)").run(sha256("legacy-unverified-scope"));
  }
  if (version < 5) {
    const authColumns = new Set(db.prepare("PRAGMA table_info(authorizations)").all().map((column) => column.name));
    if (!authColumns.has("delivery_generation")) db.exec("ALTER TABLE authorizations ADD COLUMN delivery_generation INTEGER NOT NULL DEFAULT 0");
    const resultColumns = new Set(db.prepare("PRAGMA table_info(external_action_results)").all().map((column) => column.name));
    for (const [name, definition] of [["artifact", "TEXT"], ["artifact_digest", "TEXT"], ["command_or_request_id", "TEXT"], ["legacy_unverified", "INTEGER NOT NULL DEFAULT 1"]]) {
      if (!resultColumns.has(name)) db.exec(`ALTER TABLE external_action_results ADD COLUMN ${name} ${definition}`);
    }
  }
  if (version < 6) {
    const flowColumns = new Set(db.prepare("PRAGMA table_info(flows)").all().map((column) => column.name));
    for (const [name, definition] of [
      ["state_digest", "TEXT"],
      ["mode", "TEXT NOT NULL DEFAULT 'legacy'"],
      ["mode_reason", "TEXT NOT NULL DEFAULT 'Imported before policy pinning'"],
      ["policy_id", "TEXT NOT NULL DEFAULT 'legacy-unverified'"],
      ["policy_version", "TEXT NOT NULL DEFAULT 'legacy'"],
      ["policy_digest", "TEXT"]
    ]) if (!flowColumns.has(name)) db.exec(`ALTER TABLE flows ADD COLUMN ${name} ${definition}`);
  }
  db.prepare("UPDATE schema_meta SET version=?").run(SCHEMA_VERSION);
  const migratedVersion = db.prepare("SELECT version FROM schema_meta").get().version;
  if (migratedVersion !== SCHEMA_VERSION) throw new Error(`Unsupported database schema: ${migratedVersion}`);
}
