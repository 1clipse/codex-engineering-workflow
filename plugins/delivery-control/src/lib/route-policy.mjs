import { PHASE_ORDER, ROUTE_TEMPLATES } from "../constants.mjs";

export function routeSequence(flow, { setupRequired = false, approvedSpec = false } = {}) {
  const template = ROUTE_TEMPLATES[flow];
  if (!template) throw new Error(`missing route template: ${flow}`);
  const sequence = [...template];
  if (setupRequired && !sequence.includes("setup")) sequence.splice(1, 0, "setup");
  if (approvedSpec) {
    const index = sequence.indexOf("spec");
    if (index >= 0) sequence.splice(index, 1);
  }
  return sequence;
}

export function skippedPhases(sequence) {
  return PHASE_ORDER.filter((phase) => !sequence.includes(phase));
}

export function nextInRoute(route, phase) {
  const sequence = route?.phase_sequence;
  if (!Array.isArray(sequence)) return null;
  const index = sequence.indexOf(phase);
  return index >= 0 ? sequence[index + 1] || "none" : null;
}
