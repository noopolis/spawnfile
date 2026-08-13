import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";

import {
  createCredentialProvisioningReceipt,
  type CredentialProvisioningReceipt
} from "./credentialProvisioningReceipt.js";
import type { CredentialProvisioningRequest } from "./credentialProvisioningRequest.js";
import type { TargetSecretSourceLifecycle } from "./targetSecretSourceLifecycle.js";
import {
  TARGET_SECRET_SOURCE_ERROR,
  createCanonicalTargetSecretSourceJson
} from "./targetSecretSourceRecordCommon.js";

export type ProvisionedCredentialMaterials = Map<string, Uint8Array>;
export type CredentialProvisioningEntropy = (bytes: number) => Uint8Array;
export interface CredentialProvisioningOptions {
  readonly entropy?: CredentialProvisioningEntropy;
  readonly lifecycle?: Pick<TargetSecretSourceLifecycle, "author" | "grant">;
}
export type ProvisionedCredentials = Readonly<{
  materials: ProvisionedCredentialMaterials;
  receipt: CredentialProvisioningReceipt;
}>;

const fail = (): never => { throw new Error(TARGET_SECRET_SOURCE_ERROR); };
const defaultEntropy: CredentialProvisioningEntropy = (size) => {
  const bytes = randomBytes(size);
  try { return Uint8Array.from(bytes); } finally { bytes.fill(0); }
};
const generatedToken = (size: number, entropy: CredentialProvisioningEntropy): Uint8Array => {
  let raw: Uint8Array | undefined;
  let encoded: Buffer | undefined;
  try {
    raw = entropy(size);
    if (!(raw instanceof Uint8Array) || raw.length !== size) fail();
    encoded = Buffer.from(raw);
    return new TextEncoder().encode(encoded.toString("hex"));
  } finally {
    encoded?.fill(0);
    raw?.fill(0);
  }
};

export const disposeProvisionedMaterials = (
  materials: ProvisionedCredentialMaterials
): void => {
  for (const material of materials.values()) material.fill(0);
  materials.clear();
};

export const provisionCredentials = async (
  request: CredentialProvisioningRequest,
  options: CredentialProvisioningOptions = {}
): Promise<ProvisionedCredentials> => {
  const materials: ProvisionedCredentialMaterials = new Map();
  try {
    const lifecycle = options.lifecycle
      ?? await (await import("./targetSecretSourceLifecycle.js")).initializeTargetSecretSourceLifecycle();
    const entropy = options.entropy ?? defaultEntropy;
    for (const credential of request.credentials) {
      const material = credential.kind === "generated-token"
        ? generatedToken(credential.bytes, entropy)
        : createCanonicalTargetSecretSourceJson(credential.content);
      materials.set(credential.name, material);
    }

    const sources = new Map<string, unknown>();
    for (const credential of request.credentials) {
      const material = materials.get(credential.name) ?? fail();
      const authored = await lifecycle.author(material);
      sources.set(credential.name, authored.source_handle);
    }
    for (const credential of request.credentials) {
      const sourceHandle = sources.get(credential.name);
      const granted = await lifecycle.grant({
        descriptor_digest: request.descriptor_digest,
        name: credential.name,
        run_id: request.run_id,
        scope: request.scope,
        selected_target: request.selected_target,
        source_handle: sourceHandle
      });
      if (granted.source_handle !== sourceHandle) fail();
    }
    return Object.freeze({
      materials,
      receipt: createCredentialProvisioningReceipt({ request, source_handles: sources })
    });
  } catch {
    disposeProvisionedMaterials(materials);
    return fail();
  }
};
