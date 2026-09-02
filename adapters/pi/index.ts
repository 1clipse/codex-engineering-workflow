import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

let client: Client | undefined;

async function connect(projectRoot: string) {
  if (client) return client;
  const serverPath = resolve(process.env.DELIVERY_CONTROL_SERVER ?? join(projectRoot, "plugins", "delivery-control", "dist", "server.mjs"));
  if (!existsSync(serverPath)) throw new Error(`Delivery Control server was not found: ${serverPath}`);
  client = new Client({ name: "delivery-control-pi-bridge", version: "3.0.0" });
  await client.connect(new StdioClientTransport({ command: "node", args: [serverPath], cwd: projectRoot }));
  return client;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "delivery_control",
    label: "Delivery Control",
    description: "Call one Delivery Control MCP operation defined by the local JSON workflow contract.",
    parameters: Type.Object({
      tool: Type.String({ description: "Delivery Control MCP tool name" }),
      arguments_json: Type.Optional(Type.String({ description: "JSON object passed to the selected tool" }))
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const argumentsValue = params.arguments_json ? JSON.parse(params.arguments_json) : {};
      const result = await (await connect(ctx.cwd)).callTool({ name: params.tool, arguments: argumentsValue });
      return { content: result.content, details: result.structuredContent ?? {} };
    }
  });

  pi.on("session_shutdown", async () => {
    await client?.close();
    client = undefined;
  });
}
