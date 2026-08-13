import type { TargetSecretSourceResolver } from "../target/dockerSecrets.js";
import {
  TARGET_SECRET_SOURCE_ERROR,
  assertOrdinaryJsonGraph,
  parseTargetSecretSourceOpaqueHandle,
  type OpaqueTargetSecretSourceHandle
} from "./targetSecretSourceRecordCommon.js";
import { initializeTargetSecretSourceAuthor, type TargetSecretSourceAuthor } from "./targetSecretSourceAuthor.js";
import { initializeTargetSecretSourceGrant, type TargetSecretSourceGrant } from "./targetSecretSourceGrant.js";
import {
  parseTargetSecretSourceGrantCommandInput,
  type TargetSecretSourceGrantCommandInput
} from "./targetSecretSourceGrantRecords.js";
import { initializeTargetSecretSourceResolver } from "./targetSecretSourceResolver.js";
import { initializeTargetSecretSourceRevoke, type TargetSecretSourceRevoke } from "./targetSecretSourceRevoke.js";
import { initializeTargetSecretSourceRotate, type TargetSecretSourceRotate } from "./targetSecretSourceRotate.js";

type SourceResult = Readonly<{ source_handle: OpaqueTargetSecretSourceHandle }>;
type RevokeResult = Readonly<{ kind: "grant" | "version"; source_handle: OpaqueTargetSecretSourceHandle }>;
export interface TargetSecretSourceLifecycle {
  author(secret: Uint8Array): Promise<SourceResult>;
  grant(input: unknown): Promise<SourceResult>;
  resolver: TargetSecretSourceResolver;
  revokeGrant(sourceHandle: unknown): Promise<RevokeResult>;
  revokeVersion(sourceHandle: unknown): Promise<RevokeResult>;
  rotate(sourceHandle: unknown, secret: Uint8Array): Promise<SourceResult>;
}
export interface TargetSecretSourceLifecycleOptions {
  readonly author?: TargetSecretSourceAuthor;
  readonly grant?: TargetSecretSourceGrant;
  readonly resolver?: TargetSecretSourceResolver;
  readonly revoke?: TargetSecretSourceRevoke;
  readonly rotate?: TargetSecretSourceRotate;
}

const fail = (): never => { throw new Error(TARGET_SECRET_SOURCE_ERROR); };
const exact = (raw: unknown, keys: readonly string[]): Record<string, unknown> => {
  assertOrdinaryJsonGraph(raw);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
  const record = raw as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) fail();
  return record;
};
const projectSource = (raw: unknown): SourceResult => {
  const record = exact(raw, ["source_handle"]);
  return Object.freeze({ source_handle: parseTargetSecretSourceOpaqueHandle(record.source_handle) });
};
const projectRevoke = (raw: unknown, kind: "grant" | "version"): RevokeResult => {
  const record = exact(raw, ["kind", "source_handle"]);
  if (record.kind !== kind) fail();
  return Object.freeze({ kind, source_handle: parseTargetSecretSourceOpaqueHandle(record.source_handle) });
};

export const initializeTargetSecretSourceLifecycle = async (
  options: TargetSecretSourceLifecycleOptions = {}
): Promise<TargetSecretSourceLifecycle> => {
  // Each default pins the same auth-owned hierarchy; initialize sequentially.
  const author = options.author ?? await initializeTargetSecretSourceAuthor();
  const grant = options.grant ?? await initializeTargetSecretSourceGrant();
  const rotate = options.rotate ?? await initializeTargetSecretSourceRotate();
  const revoke = options.revoke ?? await initializeTargetSecretSourceRevoke();
  const resolver = options.resolver ?? await initializeTargetSecretSourceResolver();
  return Object.freeze({
    author: async (secret: Uint8Array) => projectSource(await author.authorVersion(secret)),
    grant: async (raw: unknown) => {
      const input: TargetSecretSourceGrantCommandInput = parseTargetSecretSourceGrantCommandInput(raw);
      const result = projectSource(await grant.grantSource(input));
      if (result.source_handle !== input.source_handle) fail();
      return result;
    },
    resolver,
    revokeGrant: async (sourceHandle: unknown) => projectRevoke(await revoke.revokeGrant(sourceHandle), "grant"),
    revokeVersion: async (sourceHandle: unknown) => projectRevoke(await revoke.revokeVersion(sourceHandle), "version"),
    rotate: async (sourceHandle: unknown, secret: Uint8Array) => projectSource(await rotate.rotateSource({
      secret, source_handle: sourceHandle
    }))
  });
};
