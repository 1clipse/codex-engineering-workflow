# Engineering Workflow

Read `plugins/delivery-control/schemas/workflow-policy.json` before a durable delivery. Use the `delivery-control` MCP tools for transactional flow state and Plan Tree for business state. DSH has no verified native plan-confirmation handshake, so record a host-plan handoff when advancing a boundary.
