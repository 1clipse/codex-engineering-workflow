import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const hookScript = join(root, "hooks", "lifecycle-advisory.mjs");
const hookTemplate = join(root, "hooks", "hooks.json.template");
const policyPath = join(root, "schemas", "workflow-policy.json");

function invokeHook(input, environment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookScript], {
      cwd: root,
      env: { ...process.env, ...environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`hook exited ${code}: ${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout));
    });
    child.stdin.end(input === undefined ? "" : typeof input === "string" ? input : JSON.stringify(input));
  });
}

test("optional hook template has only the intended lifecycle events", async () => {
  const config = JSON.parse(await readFile(hookTemplate, "utf8"));
  const policy = JSON.parse(await readFile(policyPath, "utf8"));
  assert.equal(policy.delivery_protocol.lifecycle_hooks.role, "opt-in-advisory");
  assert.equal(policy.delivery_protocol.lifecycle_hooks.writes_state, false);
  assert.deepEqual(Object.keys(config.hooks).sort(), [...policy.delivery_protocol.lifecycle_hooks.events].sort());
  for (const groups of Object.values(config.hooks)) {
    assert.equal(groups.length, 1);
    const handler = groups[0].hooks[0];
    assert.equal(handler.type, "command");
    assert.match(handler.command, /<ABSOLUTE-DELIVERY-CONTROL-PLUGIN-ROOT>/);
    assert.equal(handler.timeout, 5);
  }
  await assert.rejects(stat(join(root, "hooks", "hooks.json")), { code: "ENOENT" });
});

test("SessionStart emits bounded advisory context without changing flow state", async () => {
  const result = await invokeHook(
    { hook_event_name: "SessionStart", source: "resume" },
    { DELIVERY_CONTROL_FLOW_ID: "flow-2026-09-02" },
  );
  assert.equal(result.continue, true);
  assert.match(result.systemMessage, /advisory/i);
  assert.match(result.systemMessage, /flow-2026-09-02/);
  assert.equal(result.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(result.hookSpecificOutput.additionalContext, /has not read or written workflow state/i);
});

test("PreCompact and Stop remain non-blocking reminders", async () => {
  const compact = await invokeHook({ hookEventName: "PreCompact" });
  const stop = await invokeHook({ hook_event_name: "Stop" });
  assert.equal(compact.continue, true);
  assert.match(compact.systemMessage, /before compaction/i);
  assert.equal(stop.continue, true);
  assert.match(stop.systemMessage, /not infer completion/i);
});

test("malformed input is a successful no-op", async () => {
  const result = await invokeHook("{not valid json", { DELIVERY_CONTROL_FLOW_ID: "invalid flow id!" });
  assert.deepEqual(result, { continue: true });
});

test("hook source has no state-writing, network, or subprocess capability", async () => {
  const source = await readFile(hookScript, "utf8");
  for (const forbidden of ["writeFile", "appendFile", "mkdir", "rmSync", "fetch(", "http:", "https:", "spawn(", "exec(", "McpClient"]) {
    assert.equal(source.includes(forbidden), false, `hook source must not contain ${forbidden}`);
  }
});
