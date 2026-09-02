#!/usr/bin/env node
/**
 * Delivery Control's optional Codex lifecycle hook.
 *
 * This file is intentionally a pure stdin -> stdout transform. It does not
 * inspect transcripts, start an MCP client, make network calls, or write to
 * Plan Tree / SQLite. A lifecycle notification must never become a second
 * state-transition path.
 */

const FLOW_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function readStdin() {
  return new Promise((resolve) => {
    let content = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      content += chunk;
    });
    process.stdin.on("end", () => resolve(content));
    process.stdin.on("error", () => resolve(""));
  });
}

function safeFlowId(value) {
  const candidate = typeof value === "string" ? value.trim() : "";
  return FLOW_ID_PATTERN.test(candidate) ? candidate : null;
}

function eventName(input) {
  const raw = input?.hook_event_name ?? input?.hookEventName ?? "";
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === "sessionstart") return "SessionStart";
  if (normalized === "precompact") return "PreCompact";
  if (normalized === "stop") return "Stop";
  return null;
}

function advisoryFlowId(input) {
  return safeFlowId(input?.delivery_control?.flow_id)
    ?? safeFlowId(input?.flow_id)
    ?? safeFlowId(process.env.DELIVERY_CONTROL_FLOW_ID);
}

function responseFor(input) {
  const event = eventName(input);
  const flowId = advisoryFlowId(input);
  const flowHint = flowId ? ` Flow: ${flowId}.` : "";

  if (event === "SessionStart") {
    const context = [
      "Delivery Control advisory hook is active.",
      "Before mutating a managed delivery flow, audit or resume it through the controller; Plan Tree remains the business authority.",
      "This hook has not read or written workflow state and does not authorize actions.",
    ].join(" ");
    return {
      continue: true,
      systemMessage: `Delivery Control advisory: session lifecycle guidance only.${flowHint}`,
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: context,
      },
    };
  }

  if (event === "PreCompact") {
    return {
      continue: true,
      systemMessage: `Delivery Control advisory: before compaction, preserve the flow_id, current revision, Plan Tree path, resume point, and outstanding evidence/authorization gates.${flowHint}`,
    };
  }

  if (event === "Stop") {
    return {
      continue: true,
      systemMessage: `Delivery Control advisory: do not infer completion from this stop event; close only after an explicit controller gate check.${flowHint}`,
    };
  }

  // Unknown or malformed event input must never block a Codex session.
  return { continue: true };
}

const raw = await readStdin();
let input = {};
try {
  input = raw.trim() ? JSON.parse(raw) : {};
} catch {
  input = {};
}

process.stdout.write(`${JSON.stringify(responseFor(input))}\n`);
