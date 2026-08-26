import { DeliveryControl, sha256 } from "../../src/core.mjs";

const [mode, dbPath, flowId] = process.argv.slice(2);
const controller = new DeliveryControl({
  dbPath,
  fault: (point) => {
    if (mode === "crash-after-project" && point === "after_project") process.exit(86);
  }
});

const flow = controller.inspectFlow(flowId).flow;
const result = controller.commitTransition({
  flow_id: flowId,
  expected_revision: flow.revision,
  request_digest: sha256(`${mode}:${process.pid}`),
  lease_owner: `worker:${process.pid}`,
  lease_ms: mode === "crash-after-project" ? 1 : 30_000,
  event: "advance",
  reason: `worker ${mode}`,
  patch: { current_phase: "spec", next_phase: "execute" }
});
process.stdout.write(`${JSON.stringify(result)}\n`);
controller.close();
