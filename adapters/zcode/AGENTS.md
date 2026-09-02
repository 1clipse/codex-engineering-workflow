# Engineering Workflow

Read `plugins/delivery-control/schemas/workflow-policy.json` and keep durable state in Plan Tree. Run `adapters/zcode/probe-zcode.ps1` before attempting a native integration. Until an official supported protocol is detected, use the shared JSON policy, Plan Tree and a manual handoff; a native plan is optional and never a close gate.
