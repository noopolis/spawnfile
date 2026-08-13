import { Buffer } from "node:buffer";
import { types as nodeTypes } from "node:util";

import { SpawnfileError } from "../shared/index.js";
import {
  MAX_ORGANIZATION_AGENT_MEMBERS,
  MAX_ORGANIZATION_MEMBER_ID_BYTES,
  ORGANIZATION_MEMBER_ID_PATTERN_SOURCE,
  resolveCanonicalAgentMemberId
} from "./organizationIdentity.js";
import type { CompilePlan } from "./types.js";

export const SIMFILE_WORLD_BINDINGS_VERSION = "simfile.world-bindings.v1" as const;
export const WORLD_BINDINGS_OUTPUT_FILE = "world-bindings.json";

export interface SimfileWorldBindingV1 {
  readonly member: {
    readonly id: string;
    readonly principal_id: string;
  };
  readonly run_id: string;
  readonly world_instance_id: string;
  readonly capability_manifest_digest: string;
  readonly token_env: string;
  readonly json: {
    readonly auth: "bearer";
    readonly url: string;
  };
  readonly mcp: {
    readonly auth: "bearer";
    readonly transport: "streamable_http";
    readonly url: string;
  };
}

export interface SimfileWorldBindingsV1 {
  readonly schema: typeof SIMFILE_WORLD_BINDINGS_VERSION;
  readonly bindings: readonly SimfileWorldBindingV1[];
}

export interface ResolvedWorldBindingAssignment {
  readonly binding: SimfileWorldBindingV1;
  readonly nodeId: string;
}

export interface ResolvedWorldBindings {
  readonly artifact: SimfileWorldBindingsV1;
  readonly assignments: readonly ResolvedWorldBindingAssignment[];
  readonly canonicalBytes: string;
}

type PlainRecord = Record<string, unknown>;

const MEMBER_ID = new RegExp(ORGANIZATION_MEMBER_ID_PATTERN_SOURCE, "u");
const BINDING_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const MAX_ENDPOINT_BYTES = 2_048;
const MAX_HOSTILE_DEPTH = 16;
const MAX_HOSTILE_NODES = 2_048;

const fail = (message: string): never => {
  throw new SpawnfileError("validation_error", `invalid ${SIMFILE_WORLD_BINDINGS_VERSION}: ${message}`);
};

const compareAscii = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const rejectUnsafeGraph = (
  value: unknown,
  state = { nodes: 0, seen: new WeakSet<object>() },
  depth = 0
): void => {
  if (value === null || typeof value !== "object") return;
  if (nodeTypes.isProxy(value)) fail("proxy values are not allowed");
  if (depth > MAX_HOSTILE_DEPTH) fail(`object depth exceeds ${MAX_HOSTILE_DEPTH}`);
  state.nodes += 1;
  if (state.nodes > MAX_HOSTILE_NODES) fail(`object node count exceeds ${MAX_HOSTILE_NODES}`);
  if (state.seen.has(value)) fail("aliases and cycles are not allowed");
  state.seen.add(value);

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) fail("array prototype is not canonical");
    const length = Object.getOwnPropertyDescriptor(value, "length");
    if (!length || !("value" in length) || !Number.isSafeInteger(length.value)) {
      return fail("array length is unsafe");
    }
    const count = length.value as number;
    if (count > MAX_ORGANIZATION_AGENT_MEMBERS) fail("binding cardinality exceeds organization limit");
    const keys = Reflect.ownKeys(value);
    if (keys.length !== count + 1 || keys.some((key) =>
      key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key)))) {
      fail("array contains extended properties");
    }
    for (let index = 0; index < count; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        return fail("sparse or accessor array");
      }
      rejectUnsafeGraph(descriptor.value, state, depth + 1);
    }
    return;
  }

  const keys = Reflect.ownKeys(value);
  if (keys.length > 32) fail("object property count exceeds 32");
  for (const key of keys) {
    if (typeof key !== "string") fail("symbol properties are not allowed");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      return fail("accessor or non-enumerable property");
    }
    rejectUnsafeGraph(descriptor.value, state, depth + 1);
  }
};

const exactObject = (value: unknown, fields: readonly string[], label: string): PlainRecord => {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    return fail(`${label} must be a plain object`);
  }
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length !== fields.length || Object.keys(value).length !== fields.length
    || keys.some((key) => !fields.includes(key))
    || fields.some((field) => !Object.hasOwn(value, field))) {
    return fail(`${label} keys must be ${fields.join(",")}`);
  }
  return value as PlainRecord;
};

const exactArray = (value: unknown, label: string): readonly unknown[] => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return fail(`${label} must be a plain array`);
  }
  return value;
};

const boundedId = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !BINDING_ID.test(value)
    || Buffer.byteLength(value, "ascii") > 128) {
    return fail(`${label} is invalid`);
  }
  return value;
};

const canonicalEndpoint = (value: unknown, label: "json" | "mcp"): string => {
  if (typeof value !== "string" || value.length === 0
    || Buffer.byteLength(value, "utf8") > MAX_ENDPOINT_BYTES) {
    return fail(`${label} endpoint is invalid`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fail(`${label} endpoint is invalid`);
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username !== "" || parsed.password !== ""
    || parsed.search !== "" || parsed.hash !== "" || parsed.hostname === ""
    || value.includes("?") || value.includes("#")
    || parsed.href !== value || parsed.pathname.endsWith("/")) {
    return fail(`${label} endpoint must be a canonical credential-free http(s) URL`);
  }
  if (label === "json" && !parsed.pathname.endsWith("/v1/world")) {
    return fail("json endpoint must end with /v1/world");
  }
  return value;
};

const parseBinding = (value: unknown, index: number): SimfileWorldBindingV1 => {
  const entry = exactObject(value, [
    "member",
    "run_id",
    "world_instance_id",
    "capability_manifest_digest",
    "token_env",
    "json",
    "mcp"
  ], `bindings[${index}]`);
  const member = exactObject(entry.member, ["id", "principal_id"], `bindings[${index}].member`);
  const memberId = typeof member.id === "string" ? member.id : "";
  if (!MEMBER_ID.test(memberId)
    || Buffer.byteLength(memberId, "ascii") > MAX_ORGANIZATION_MEMBER_ID_BYTES
    || member.principal_id !== `agent:${memberId}`) {
    return fail(`bindings[${index}] member identity is invalid`);
  }
  const digest = entry.capability_manifest_digest;
  if (typeof digest !== "string" || !DIGEST.test(digest)) {
    return fail(`bindings[${index}] capability manifest digest is invalid`);
  }
  const tokenEnv = entry.token_env;
  if (typeof tokenEnv !== "string" || !ENV_NAME.test(tokenEnv)) {
    return fail(`bindings[${index}] token env is invalid`);
  }
  const json = exactObject(entry.json, ["auth", "url"], `bindings[${index}].json`);
  const mcp = exactObject(entry.mcp, ["auth", "transport", "url"], `bindings[${index}].mcp`);
  if (json.auth !== "bearer" || mcp.auth !== "bearer" || mcp.transport !== "streamable_http") {
    return fail(`bindings[${index}] endpoint authentication is invalid`);
  }
  return {
    member: { id: memberId, principal_id: member.principal_id as string },
    run_id: boundedId(entry.run_id, `bindings[${index}].run_id`),
    world_instance_id: boundedId(entry.world_instance_id, `bindings[${index}].world_instance_id`),
    capability_manifest_digest: digest,
    token_env: tokenEnv,
    json: { auth: "bearer", url: canonicalEndpoint(json.url, "json") },
    mcp: { auth: "bearer", transport: "streamable_http", url: canonicalEndpoint(mcp.url, "mcp") }
  };
};

const freezeCopy = <T>(value: T): T => {
  const copy = structuredClone(value);
  const freeze = (current: unknown): void => {
    if (current === null || typeof current !== "object" || Object.isFrozen(current)) return;
    Object.freeze(current);
    for (const child of Object.values(current as PlainRecord)) freeze(child);
  };
  freeze(copy);
  return copy;
};

export const parseSimfileWorldBindings = (raw: unknown): SimfileWorldBindingsV1 => {
  rejectUnsafeGraph(raw);
  const root = exactObject(raw, ["schema", "bindings"], "root");
  if (root.schema !== SIMFILE_WORLD_BINDINGS_VERSION) fail("schema is invalid");
  const input = exactArray(root.bindings, "bindings");
  if (input.length === 0 || input.length > MAX_ORGANIZATION_AGENT_MEMBERS) {
    fail("bindings must contain 1 to 128 entries");
  }
  const bindings = input.map((entry, index) => parseBinding(entry, index));
  const members = new Set<string>();
  const principals = new Set<string>();
  const tokenEnvs = new Set<string>();
  const first = bindings[0]!;
  for (const binding of bindings) {
    if (members.has(binding.member.id) || principals.has(binding.member.principal_id)
      || tokenEnvs.has(binding.token_env)) {
      fail("bindings contain a duplicate member, principal, or token env");
    }
    if (binding.run_id !== first.run_id || binding.world_instance_id !== first.world_instance_id) {
      fail("bindings must share one run and world instance");
    }
    members.add(binding.member.id);
    principals.add(binding.member.principal_id);
    tokenEnvs.add(binding.token_env);
  }
  bindings.sort((left, right) =>
    compareAscii(left.member.principal_id, right.member.principal_id)
    || compareAscii(left.member.id, right.member.id));
  return freezeCopy({ schema: SIMFILE_WORLD_BINDINGS_VERSION, bindings });
};

export const renderSimfileWorldBindings = (artifact: SimfileWorldBindingsV1): string =>
  `${JSON.stringify(parseSimfileWorldBindings(artifact), null, 2)}\n`;

export const resolveWorldBindings = (plan: CompilePlan, raw: unknown): ResolvedWorldBindings => {
  const artifact = parseSimfileWorldBindings(raw);
  const identity = plan.organizationIdentity;
  if (!identity) return fail("organization identity is required");
  const authorityByMember = new Map(identity.agentMembers.map((member) => [member.memberId, member]));
  const nodeByMember = new Map<string, string>();
  for (const node of plan.nodes) {
    if (node.kind !== "agent") continue;
    const memberId = resolveCanonicalAgentMemberId(plan, node.value.source);
    if (memberId === undefined) continue;
    const authority = authorityByMember.get(memberId);
    if (!authority || authority.principalId !== `agent:${memberId}` || nodeByMember.has(memberId)) {
      fail(`organization identity does not resolve exactly once for ${memberId}`);
    }
    nodeByMember.set(memberId, node.id);
  }
  if (nodeByMember.size !== identity.agentMembers.length
    || artifact.bindings.length !== identity.agentMembers.length) {
    fail("binding and organization cardinality do not match");
  }
  const assignments = artifact.bindings.map((binding) => {
    const authority = authorityByMember.get(binding.member.id);
    const nodeId = nodeByMember.get(binding.member.id);
    if (!authority || authority.principalId !== binding.member.principal_id || !nodeId) {
      return fail(`binding does not join organization member ${binding.member.id}`);
    }
    return { binding: freezeCopy(binding), nodeId };
  });
  if (new Set(assignments.map((assignment) => assignment.nodeId)).size !== assignments.length) {
    fail("binding assignments contain a duplicate node");
  }
  return freezeCopy({
    artifact,
    assignments,
    canonicalBytes: renderSimfileWorldBindings(artifact)
  });
};

export const findWorldBindingForNode = (
  resolved: ResolvedWorldBindings | undefined,
  nodeId: string
): SimfileWorldBindingV1 | undefined => {
  if (!resolved) return undefined;
  const matches = resolved.assignments.filter((assignment) => assignment.nodeId === nodeId);
  if (matches.length > 1) fail(`node ${nodeId} has duplicate binding assignments`);
  return matches[0]?.binding;
};
