import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

test("plugin packaging exposes a host-discoverable MCP server map", async () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const manifest = JSON.parse(await readFile(join(root, ".codex-plugin", "plugin.json"), "utf8"));
  const config = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"));

  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.deepEqual(config.mcpServers?.["delivery-control"], {
    command: "node",
    args: ["./dist/server.mjs"],
    cwd: ".",
  });
});

test("bundled stdio MCP exposes the complete stable tool surface", async () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const serverPath = process.env.DELIVERY_CONTROL_SERVER || join(root, "dist", "server.mjs");
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
  const client = new Client({ name: "delivery-control-test", version: "1.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    const expected = [
      "advance_flow", "audit_consistency", "cancel_flow", "close_flow", "close_verified_flow", "commit_transition", "confirm_authorization",
      "confirm_native_plan", "consume_authorization", "get_metrics", "initialize_flow", "inspect_flow", "project_native_plan", "propose_transition",
      "record_delivery_evidence", "record_review_findings", "recover_flow", "request_authorization", "resolve_drift", "select_route", "start_or_resume_flow", "validate_evidence"
    ].sort();
    assert.deepEqual(names, expected);
    for (const tool of listed.tools) {
      assert.equal(typeof tool.annotations?.readOnlyHint, "boolean", `${tool.name} missing readOnlyHint`);
      assert.equal(tool.annotations?.openWorldHint, false, `${tool.name} must remain local-only`);
    }
    const metrics = await client.callTool({ name: "get_metrics", arguments: {} });
    assert.equal(metrics.structuredContent.ok, true);
    assert.match(metrics.structuredContent.privacy, /aggregate counts only/);
  } finally {
    await client.close();
  }
});
