import { Buffer } from "node:buffer";
import { open } from "node:fs/promises";

import { parseRunId, parseSelectedTargetReceipt, type SelectedTargetReceipt } from "../target/contracts.js";
import {
  TARGET_SECRET_SOURCE_ERROR,
  assertOrdinaryJsonGraph
} from "./targetSecretSourceRecordCommon.js";

export const CREDENTIAL_PROVISIONING_REQUEST_VERSION =
  "spawnfile.auth.credential-provisioning.request.v1" as const;
export const MAX_CREDENTIAL_PROVISIONING_REQUEST_BYTES = 65_536;

export type GeneratedTokenCredentialRequest = Readonly<{
  bytes: number;
  env: string;
  kind: "generated-token";
  name: string;
}>;
/**
 * `derived-config.content` is DECLARATIVE, non-secret configuration that the caller
 * authored into the request by design — it is stored as a target secret for uniform
 * handling, but it is not minted material and its presence in the caller's own request
 * file is not a leak.
 */
export type DerivedConfigCredentialRequest = Readonly<{
  content: unknown;
  env: string;
  kind: "derived-config";
  name: string;
}>;
export type CredentialProvisioningCredentialRequest =
  | GeneratedTokenCredentialRequest
  | DerivedConfigCredentialRequest;
export type CredentialProvisioningWorldMember = Readonly<{
  id: string;
  principal_id: string;
  token_credential_name: string;
}>;
export type CredentialProvisioningWorldBindings = Readonly<{
  json_url: string;
  mcp_url: string;
  members: readonly CredentialProvisioningWorldMember[];
  world_instance_id: string;
}>;
export type CredentialProvisioningModelEngineAuth = Readonly<{
  from?: string;
  kind: "codex";
  profile: string;
}>;
export type CredentialProvisioningRequest = Readonly<{
  credentials: readonly CredentialProvisioningCredentialRequest[];
  descriptor_digest: string;
  model_engine_auth?: CredentialProvisioningModelEngineAuth;
  run_id: string;
  scope: string;
  selected_target: SelectedTargetReceipt;
  version: typeof CREDENTIAL_PROVISIONING_REQUEST_VERSION;
  world_bindings?: CredentialProvisioningWorldBindings;
}>;

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const ENV = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/u;
const FORBIDDEN_KEYS = new Set(["bearer", "material", "password", "secret", "token", "value"]);

const fail = (): never => { throw new Error(TARGET_SECRET_SOURCE_ERROR); };
const normalize = <T>(work: () => T): T => {
  try { return work(); } catch { return fail(); }
};
const exact = (
  raw: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): Record<string, unknown> => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return fail();
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record);
  const allowed = new Set([...required, ...optional]);
  if (keys.some((key) => !allowed.has(key)) || required.some((key) => !Object.hasOwn(record, key))) fail();
  return record;
};
const string = (raw: unknown): string =>
  typeof raw === "string" && raw.length > 0 ? raw : fail();
const nonEmptyArray = (raw: unknown): readonly unknown[] =>
  Array.isArray(raw) && raw.length > 0 ? raw : fail();
const generatedByteCount = (raw: unknown): number =>
  typeof raw === "number"
    && Number.isInteger(raw)
    && raw >= 16
    && raw <= 128
    ? raw
    : fail();
const descriptorDigest = (raw: unknown): string =>
  typeof raw === "string" && DIGEST.test(raw) ? raw : fail();
const rejectForbiddenKeys = (raw: unknown): void => {
  const pending: unknown[] = [raw];
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) fail();
      pending.push(nested);
    }
  }
};
const parseCredential = (raw: unknown): CredentialProvisioningCredentialRequest => {
  const base = exact(raw, ["env", "kind", "name"], ["bytes", "content"]);
  const name = string(base.name);
  const env = string(base.env);
  if (!ENV.test(env)) fail();
  if (base.kind === "generated-token") {
    const record = exact(raw, ["bytes", "env", "kind", "name"]);
    const bytes = generatedByteCount(record.bytes);
    return Object.freeze({ bytes, env, kind: "generated-token", name });
  }
  if (base.kind === "derived-config") {
    const record = exact(raw, ["content", "env", "kind", "name"]);
    assertOrdinaryJsonGraph(record.content);
    return Object.freeze({ content: structuredClone(record.content), env, kind: "derived-config", name });
  }
  return fail();
};
const parseWorldBindings = (raw: unknown): CredentialProvisioningWorldBindings => {
  const record = exact(raw, ["json_url", "mcp_url", "members", "world_instance_id"]);
  const rawMembers = nonEmptyArray(record.members);
  const members = rawMembers.map((entry) => {
    const member = exact(entry, ["id", "principal_id", "token_credential_name"]);
    return Object.freeze({
      id: string(member.id),
      principal_id: string(member.principal_id),
      token_credential_name: string(member.token_credential_name)
    });
  });
  return Object.freeze({
    json_url: string(record.json_url),
    mcp_url: string(record.mcp_url),
    members: Object.freeze(members),
    world_instance_id: string(record.world_instance_id)
  });
};
const parseModelEngineAuth = (raw: unknown): CredentialProvisioningModelEngineAuth => {
  const record = exact(raw, ["kind", "profile"], ["from"]);
  if (record.kind !== "codex") fail();
  const from = record.from === undefined ? undefined : string(record.from);
  return Object.freeze({
    ...(from === undefined ? {} : { from }),
    kind: "codex" as const,
    profile: string(record.profile)
  });
};

export const parseCredentialProvisioningRequest = (raw: unknown): CredentialProvisioningRequest => normalize(() => {
  assertOrdinaryJsonGraph(raw);
  rejectForbiddenKeys(raw);
  const record = exact(
    raw,
    ["credentials", "descriptor_digest", "run_id", "scope", "selected_target", "version"],
    ["model_engine_auth", "world_bindings"]
  );
  if (record.version !== CREDENTIAL_PROVISIONING_REQUEST_VERSION) fail();
  const parsedDescriptorDigest = descriptorDigest(record.descriptor_digest);
  const rawCredentials = nonEmptyArray(record.credentials);
  const credentials = rawCredentials.map(parseCredential);
  if (new Set(credentials.map(({ name }) => name)).size !== credentials.length
    || new Set(credentials.map(({ env }) => env)).size !== credentials.length) fail();
  const worldBindings = record.world_bindings === undefined
    ? undefined
    : parseWorldBindings(record.world_bindings);
  if (worldBindings) {
    const names = new Set(credentials.map(({ name }) => name));
    if (worldBindings.members.some(({ token_credential_name: name }) => !names.has(name))) fail();
  }
  const modelEngineAuth = record.model_engine_auth === undefined
    ? undefined
    : parseModelEngineAuth(record.model_engine_auth);
  return Object.freeze({
    credentials: Object.freeze(credentials),
    descriptor_digest: parsedDescriptorDigest,
    ...(modelEngineAuth === undefined ? {} : { model_engine_auth: modelEngineAuth }),
    run_id: parseRunId(record.run_id),
    scope: string(record.scope),
    selected_target: parseSelectedTargetReceipt(record.selected_target),
    version: CREDENTIAL_PROVISIONING_REQUEST_VERSION,
    ...(worldBindings === undefined ? {} : { world_bindings: worldBindings })
  });
});

export const parseCredentialProvisioningRequestBytes = (raw: Uint8Array): CredentialProvisioningRequest =>
  normalize(() => {
    if (!(raw instanceof Uint8Array) || raw.length < 1 || raw.length > MAX_CREDENTIAL_PROVISIONING_REQUEST_BYTES) fail();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    return parseCredentialProvisioningRequest(JSON.parse(text));
  });

export const readCredentialProvisioningRequestFile = async (
  filePath: string
): Promise<CredentialProvisioningRequest> => {
  let bytes: Buffer | undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, "r");
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > MAX_CREDENTIAL_PROVISIONING_REQUEST_BYTES) fail();
    bytes = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset !== info.size) fail();
    return parseCredentialProvisioningRequestBytes(bytes.subarray(0, offset));
  } catch {
    return fail();
  } finally {
    bytes?.fill(0);
    await handle?.close().catch(() => undefined);
  }
};
