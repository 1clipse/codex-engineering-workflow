import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const pluginRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(pluginRoot, "..", "..");
const adaptersRoot = join(repoRoot, "adapters");
const policy = JSON.parse(readFileSync(join(pluginRoot, "schemas", "workflow-policy.json"), "utf8"));

test("canonical JSON owns every named host profile", () => {
  assert.deepEqual(Object.keys(policy.host_profiles).sort(), ["claude-code", "codex", "dsh", "opencode", "pi", "zcode"]);
  assert.equal(policy.delivery_protocol.host_plan.fallback, "plan_sync unavailable with explicit handoff");
  for (const [host, profile] of Object.entries(policy.host_profiles)) {
    assert.ok(profile.support, `${host} has support tier`);
    assert.ok(profile.adapter?.target, `${host} has adapter target`);
  }
});

test("generated host capabilities and direct-MCP templates remain current", () => {
  const capabilities = JSON.parse(readFileSync(join(adaptersRoot, "host-capabilities.json"), "utf8"));
  assert.equal(capabilities.authority, "plugins/delivery-control/schemas/workflow-policy.json");
  assert.deepEqual(capabilities.hosts, policy.host_profiles);
  for (const [host, filename] of [["claude-code", "claude-code.json.template"], ["opencode", "opencode.json.template"], ["dsh", "dsh.yml.template"]]) {
    const path = join(adaptersRoot, host, filename);
    assert.ok(existsSync(path), `${host} generated template exists`);
    assert.match(readFileSync(path, "utf8"), /\{SERVER_PATH\}/);
  }
});

test("adapter installer produces reviewable, project-local fragments", () => {
  const outputRoot = mkdtempSync(join(tmpdir(), "delivery-control-adapter-"));
  try {
    const run = (host, extension) => {
      const target = join(outputRoot, `${host}.${extension}`);
      const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(adaptersRoot, "install-adapter.ps1"), "-Host", host, "-ProjectRoot", repoRoot, "-OutputPath", target], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return target;
    };
    const claude = JSON.parse(readFileSync(run("claude-code", "json"), "utf8"));
    assert.equal(claude.mcpServers["delivery-control"].command, "node");
    assert.match(claude.mcpServers["delivery-control"].args[0], /dist[\\/]server\.mjs$/);
    const opencode = JSON.parse(readFileSync(run("opencode", "json"), "utf8"));
    assert.equal(opencode.mcp["delivery-control"].type, "local");
    assert.equal(opencode.mcp["delivery-control"].enabled, true);
    assert.match(readFileSync(run("dsh", "yml"), "utf8"), /@deepseek-ai\/dsh-mcp-client/);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("Pi bridge and ZCode probe keep their explicit capability boundaries", () => {
  const piPackage = JSON.parse(readFileSync(join(adaptersRoot, "pi", "package.json"), "utf8"));
  assert.ok(piPackage.dependencies["@modelcontextprotocol/sdk"]);
  assert.ok(existsSync(join(adaptersRoot, "pi", "package-lock.json")));
  assert.match(readFileSync(join(adaptersRoot, "pi", "index.ts"), "utf8"), /StdioClientTransport/);
  const probe = readFileSync(join(adaptersRoot, "zcode", "probe-zcode.ps1"), "utf8");
  assert.match(probe, /Get-Command zcode/);
  assert.doesNotMatch(probe, /Set-Content|Add-Content|Remove-Item/);
});
