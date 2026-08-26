import { createHash } from "node:crypto";

export const ok = (value) => ({ ok: true, ...value });
export const fail = (code, message, details = {}) => ({ ok: false, error: { code, message, ...details } });
export const nowIso = (clock) => new Date(clock()).toISOString();

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export const sha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

export function requestDigest(operation, input, fields) {
  return sha256(canonical({ operation, ...Object.fromEntries(fields.map((field) => [field, input[field]])) }));
}

export function assertString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}
