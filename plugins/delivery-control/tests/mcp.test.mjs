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

test("bundled stdio MCP exposes the compact policy-driven tool surface", async () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const serverPath = process.env.DELIVERY_CONTROL_SERVER || join(root, "dist", "server.mjs");
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
  const client = new Client({ name: "delivery-control-test", version: "1.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    const expected = [
      "audit_or_recover_flow", "authorize_external_action", "checkpoint_flow", "close_or_cancel_flow",
      "record_evidence", "route_flow", "start_or_resume_flow"
    ].sort();
    assert.deepEqual(names, expected);

    const byName = Object.fromEntries(listed.tools.map((tool) => [tool.name, tool]));
    assert.equal(byName.route_flow.inputSchema.properties.skipped_phases, undefined, "route_flow must derive skipped phases");
    assert.equal(byName.route_flow.inputSchema.properties.next_phase, undefined, "route_flow must derive next_phase");
    assert.equal(byName.close_or_cancel_flow.inputSchema.properties.patch, undefined, "close_or_cancel_flow must not expose arbitrary state patches");

    assert.match(byName.audit_or_recover_flow.description, /Recovery never overwrites unresolved controlled-state drift/);
    assert.match(byName.record_evidence.description, /Artifact paths are confined to plan_root/);
    assert.match(byName.authorize_external_action.description, /single-use/);

    for (const tool of listed.tools) {
      assert.equal(typeof tool.annotations?.readOnlyHint, "boolean", `${tool.name} missing readOnlyHint`);
      assert.equal(tool.annotations?.openWorldHint, false, `${tool.name} must remain local-only`);
    }
  } finally {
    await client.close();
  }
});
