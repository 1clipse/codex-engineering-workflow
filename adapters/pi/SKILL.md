---
name: engineering-workflow
description: Start a JSON-controlled delivery flow through the local Delivery Control bridge.
---

# Engineering Workflow

Read `plugins/delivery-control/schemas/workflow-policy.json`. Use the `delivery_control` Pi tool for durable flow changes and keep business state in Plan Tree. Pi has no native host-plan confirmation, so record an unavailable handoff when a phase boundary requires plan synchronization.
