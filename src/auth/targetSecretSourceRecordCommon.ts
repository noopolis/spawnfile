import {
  MAX_JSON_GRAPH_DEPTH as TARGET_MAX_JSON_GRAPH_DEPTH,
  MAX_JSON_GRAPH_KEYS as TARGET_MAX_JSON_GRAPH_KEYS,
  MAX_JSON_GRAPH_NODES as TARGET_MAX_JSON_GRAPH_NODES,
  MAX_JSON_GRAPH_STRING_BYTES as TARGET_MAX_JSON_GRAPH_STRING_BYTES,
  assertOrdinaryJsonGraph as assertTargetOrdinaryJsonGraph,
  parseOpaqueTargetHandle
} from "../target/contracts.js";
import { Buffer } from "node:buffer";

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });
const BASE64_SECRET_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
export const TARGET_SECRET_SOURCE_ERROR = "invalid target secret source record";
export const MAX_TARGET_SECRET_SOURCE_SECRET_BYTES = 32_768;
const MAX_ENCODED_SECRET_CHARACTERS = 4 * Math.ceil(MAX_TARGET_SECRET_SOURCE_SECRET_BYTES / 3);

export type OpaqueTargetSecretSourceHandle = ReturnType<typeof parseOpaqueTargetHandle>;
export const MAX_JSON_GRAPH_DEPTH = TARGET_MAX_JSON_GRAPH_DEPTH;
export const MAX_JSON_GRAPH_KEYS = TARGET_MAX_JSON_GRAPH_KEYS;
export const MAX_JSON_GRAPH_NODES = TARGET_MAX_JSON_GRAPH_NODES;
export const MAX_JSON_GRAPH_STRING_BYTES = TARGET_MAX_JSON_GRAPH_STRING_BYTES;

const fail = (): never => { throw new Error(TARGET_SECRET_SOURCE_ERROR); };
const normalize = <T>(work: () => T): T => {
  try {
    return work();
  } catch {
    return fail();
  }
};
const compareCodeUnits = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const canonicalize = (value: unknown): unknown => {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object") return fail();
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) => compareCodeUnits(a, b))) {
    result[key] = canonicalize(nested);
  }
  return result;
};

const assertCanonicalBytes = (raw: Uint8Array, text: string): void => {
  const canonical = TEXT_ENCODER.encode(text);
  try {
    if (canonical.length !== raw.length) fail();
    for (let index = 0; index < raw.length; index += 1) if (canonical[index] !== raw[index]) fail();
  } finally {
    canonical.fill(0);
  }
};

export const assertOrdinaryJsonGraph = (raw: unknown): void => normalize(() => {
  assertTargetOrdinaryJsonGraph(raw);
});

export const parseCanonicalTargetSecretSourceJson = (raw: unknown): unknown => normalize(() => {
  if (!(raw instanceof Uint8Array) || raw.length > MAX_JSON_GRAPH_STRING_BYTES) fail();
  const bytes = raw as Uint8Array;
  const parsed = JSON.parse(TEXT_DECODER.decode(bytes));
  assertTargetOrdinaryJsonGraph(parsed);
  assertCanonicalBytes(bytes, JSON.stringify(canonicalize(parsed)));
  return parsed;
});

export const createCanonicalTargetSecretSourceJson = (raw: unknown): Uint8Array => normalize(() => {
  assertTargetOrdinaryJsonGraph(raw);
  const encoded = TEXT_ENCODER.encode(JSON.stringify(canonicalize(raw)));
  try {
    if (encoded.length > MAX_JSON_GRAPH_STRING_BYTES) fail();
    return Uint8Array.from(encoded);
  } finally {
    encoded.fill(0);
  }
});

export const parseTargetSecretSourceOpaqueHandle = (raw: unknown): OpaqueTargetSecretSourceHandle => normalize(() =>
  parseOpaqueTargetHandle(raw)
);

export const encodeTargetSecretSourceSecret = (raw: unknown): string => normalize(() => {
  if (!(raw instanceof Uint8Array) || raw.length === 0 || raw.length > MAX_TARGET_SECRET_SOURCE_SECRET_BYTES) fail();
  const copy = Uint8Array.from(raw as Uint8Array);
  const encoded = Buffer.from(copy);
  try {
    return encoded.toString("base64");
  } finally {
    encoded.fill(0);
    copy.fill(0);
  }
});

export const decodeTargetSecretSourceSecret = (raw: unknown): Uint8Array => normalize(() => {
  if (typeof raw !== "string" || raw.length > MAX_ENCODED_SECRET_CHARACTERS || !BASE64_SECRET_PATTERN.test(raw)) fail();
  const encoded = raw as string;
  const decoded = Buffer.from(encoded, "base64");
  try {
    if (decoded.toString("base64") !== encoded || decoded.length === 0 || decoded.length > MAX_TARGET_SECRET_SOURCE_SECRET_BYTES) fail();
    return Uint8Array.from(decoded);
  } finally {
    decoded.fill(0);
  }
});
