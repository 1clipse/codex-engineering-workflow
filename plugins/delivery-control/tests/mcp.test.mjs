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
      "advance_phase", "audit_consistency", "cancel_flow", "close_flow", "confirm_authorization",
      "confirm_native_plan", "consume_authorization", "get_metrics", "initialize_flow", "inspect_flow", "project_native_plan",
      "record_delivery_evidence", "record_external_action_result", "record_review_findings", "recover_flow", "request_authorization", "resolve_drift", "revise_scope", "select_route", "start_or_resume_flow", "validate_evidence"
    ].sort();
    assert.deepEqual(names, expected);

    const byName = Object.fromEntries(listed.tools.map((tool) => [tool.name, tool]));
    assert.equal(byName.select_route.inputSchema.properties.skipped_phases, undefined, "select_route must derive skipped phases");
    assert.equal(byName.select_route.inputSchema.properties.next_phase, undefined, "select_route must derive next_phase");
    assert.equal(byName.cancel_flow.inputSchema.properties.patch, undefined, "cancel_flow must not expose arbitrary state patches");

    const actionResultInput = byName.record_external_action_result.inputSchema;
    assert.ok(actionResultInput.required.includes("result"), "record_external_action_result must require result");
    const actionResultRequired = actionResultInput.properties.result.required;
    for (const field of ["artifact", "artifact_digest", "command_or_request_id"]) {
      assert.ok(actionResultRequired.includes(field), `external action result must require ${field}`);
    }

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
