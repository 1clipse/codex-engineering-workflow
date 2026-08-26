---
name: engineering-workflow
description: Start a JSON-controlled delivery flow with Delivery Control and Plan Tree.
---

# Engineering Workflow

Read `plugins/delivery-control/schemas/workflow-policy.json` and `skills/engineering-workflow/references/host-capabilities.json`. They are the delivery-policy authority.

Use the `delivery-control` MCP tools to start or resume a flow, record evidence and close only after its gates pass. Keep durable decisions, scope and handoff in Plan Tree. Claude Code has no confirmed equivalent to Codex native Plan synchronization, so confirm an unavailable host-plan handoff instead of claiming a synchronized plan.
