---
name: engineering-workflow
description: Start a JSON-controlled delivery flow with Delivery Control and Plan Tree.
---

# Engineering Workflow

Read `plugins/delivery-control/schemas/workflow-policy.json` and `skills/engineering-workflow/references/host-capabilities.json`. They are the delivery-policy authority.

Use the seven high-level `delivery-control` MCP operations to start/resume, route, checkpoint, record evidence, authorize external actions, audit/recover, and close/cancel. Keep durable decisions, scope and handoff in Plan Tree. A host plan is optional session guidance only; Claude Code does not need to emulate Codex native Plan to progress or close a flow.
