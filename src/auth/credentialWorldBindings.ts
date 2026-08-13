import { createHash } from "node:crypto";

import {
  SIMFILE_WORLD_BINDINGS_VERSION,
  parseSimfileWorldBindings,
  type SimfileWorldBindingsV1
} from "../compiler/worldBindings.js";
import type { CredentialProvisioningReceipt } from "./credentialProvisioningReceipt.js";
import type { CredentialProvisioningRequest } from "./credentialProvisioningRequest.js";
import {
  TARGET_SECRET_SOURCE_ERROR,
  assertOrdinaryJsonGraph,
  createCanonicalTargetSecretSourceJson
} from "./targetSecretSourceRecordCommon.js";

export const RESOLVED_WORLD_GRANTS_VERSION = "spawnfile.auth.resolved-world-grants.v1" as const;
export type ResolvedWorldGrant = Readonly<{
  capability_manifest: unknown;
  member_id: string;
  principal_id: string;
}>;
export type ResolvedWorldGrants = Readonly<{
  grants: readonly ResolvedWorldGrant[];
  run_id: string;
  version: typeof RESOLVED_WORLD_GRANTS_VERSION;
  world_instance_id: string;
}>;

const fail = (): never => { throw new Error(TARGET_SECRET_SOURCE_ERROR); };
const exact = (raw: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return fail();
  const record = raw as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail();
  return record;
};
const string = (raw: unknown): string =>
  typeof raw === "string" && raw.length > 0 ? raw : fail();
const nonEmptyArray = (raw: unknown): readonly unknown[] =>
  Array.isArray(raw) && raw.length > 0 ? raw : fail();

export const parseResolvedWorldGrants = (raw: unknown): ResolvedWorldGrants => {
  try {
    assertOrdinaryJsonGraph(raw);
    const record = exact(raw, ["grants", "run_id", "version", "world_instance_id"]);
    if (record.version !== RESOLVED_WORLD_GRANTS_VERSION) fail();
    const rawGrants = nonEmptyArray(record.grants);
    const grants = rawGrants.map((rawGrant) => {
      const grant = exact(rawGrant, ["capability_manifest", "member_id", "principal_id"]);
      assertOrdinaryJsonGraph(grant.capability_manifest);
      return Object.freeze({
        capability_manifest: structuredClone(grant.capability_manifest),
        member_id: string(grant.member_id),
        principal_id: string(grant.principal_id)
      });
    });
    return Object.freeze({
      grants: Object.freeze(grants),
      run_id: string(record.run_id),
      version: RESOLVED_WORLD_GRANTS_VERSION,
      world_instance_id: string(record.world_instance_id)
    });
  } catch {
    return fail();
  }
};

export const buildProvisionedWorldBindings = (input: Readonly<{
  receipt: CredentialProvisioningReceipt;
  request: CredentialProvisioningRequest;
  resolved: unknown;
}>): SimfileWorldBindingsV1 => {
  try {
    const world = input.request.world_bindings ?? fail();
    if (input.receipt.run_id !== input.request.run_id
      || input.receipt.scope !== input.request.scope) fail();
    const resolved = parseResolvedWorldGrants(input.resolved);
    if (resolved.run_id !== input.request.run_id
      || resolved.world_instance_id !== world.world_instance_id
      || resolved.grants.length !== world.members.length) fail();
    const declared = new Map(world.members.map((member) => [member.id, member]));
    if (declared.size !== world.members.length) fail();
    const receiptByName = new Map(input.receipt.credentials.map((credential) => [credential.name, credential]));
    const digests = new Set<string>();
    const bindings = resolved.grants.map((grant) => {
      const member = declared.get(grant.member_id) ?? fail();
      if (member.principal_id !== grant.principal_id) fail();
      const credential = receiptByName.get(member.token_credential_name) ?? fail();
      const requestedCredential = input.request.credentials.find(
        ({ name }) => name === member.token_credential_name
      ) ?? fail();
      if (credential.env !== requestedCredential.env) fail();
      let canonical: Uint8Array | undefined;
      try {
        canonical = createCanonicalTargetSecretSourceJson(grant.capability_manifest);
        const capabilityDigest = `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
        if (digests.has(capabilityDigest)) fail();
        digests.add(capabilityDigest);
        return {
          capability_manifest_digest: capabilityDigest,
          json: { auth: "bearer" as const, url: world.json_url },
          mcp: {
            auth: "bearer" as const,
            transport: "streamable_http" as const,
            url: world.mcp_url
          },
          member: { id: member.id, principal_id: member.principal_id },
          run_id: input.request.run_id,
          token_env: credential.env,
          world_instance_id: world.world_instance_id
        };
      } finally {
        canonical?.fill(0);
      }
    });
    if (bindings.length !== declared.size) fail();
    return parseSimfileWorldBindings({
      bindings,
      schema: SIMFILE_WORLD_BINDINGS_VERSION
    });
  } catch {
    return fail();
  }
};
