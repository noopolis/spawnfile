import type { CredentialProvisioningRequest } from "./credentialProvisioningRequest.js";
import {
  TARGET_SECRET_SOURCE_ERROR,
  parseTargetSecretSourceOpaqueHandle,
  type OpaqueTargetSecretSourceHandle
} from "./targetSecretSourceRecordCommon.js";

export const CREDENTIAL_PROVISIONING_RECEIPT_VERSION =
  "spawnfile.auth.credential-provisioning.receipt.v1" as const;
export type CredentialProvisioningPhase =
  | "author"
  | "grant"
  | "model_engine_auth"
  | "env_file"
  | "world_bindings";
export type CredentialProvisioningReceiptCredential = Readonly<{
  env: string;
  name: string;
  scope: string;
  source_handle: OpaqueTargetSecretSourceHandle;
}>;
export type CredentialProvisioningReceipt = Readonly<{
  credentials: readonly CredentialProvisioningReceiptCredential[];
  env_file_digest?: string;
  phases: readonly CredentialProvisioningPhase[];
  run_id: string;
  scope: string;
  version: typeof CREDENTIAL_PROVISIONING_RECEIPT_VERSION;
  world_bindings_digest?: string;
}>;

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const fail = (): never => { throw new Error(TARGET_SECRET_SOURCE_ERROR); };
const digest = (raw: unknown): string =>
  typeof raw === "string" && DIGEST.test(raw) ? raw : fail();

export const createCredentialProvisioningReceipt = (input: Readonly<{
  request: CredentialProvisioningRequest;
  source_handles: ReadonlyMap<string, unknown>;
}>): CredentialProvisioningReceipt => {
  try {
    const credentials = input.request.credentials.map((credential) => {
      const sourceHandle = input.source_handles.get(credential.name);
      return Object.freeze({
        env: credential.env,
        name: credential.name,
        scope: input.request.scope,
        source_handle: parseTargetSecretSourceOpaqueHandle(sourceHandle)
      });
    });
    if (input.source_handles.size !== credentials.length) fail();
    return Object.freeze({
      credentials: Object.freeze(credentials),
      phases: Object.freeze(["author", "grant"] as const),
      run_id: input.request.run_id,
      scope: input.request.scope,
      version: CREDENTIAL_PROVISIONING_RECEIPT_VERSION
    });
  } catch {
    return fail();
  }
};

export const finalizeCredentialProvisioningReceipt = (
  receipt: CredentialProvisioningReceipt,
  outputs: Readonly<{
    env_file_digest?: string;
    model_engine_auth?: boolean;
    world_bindings_digest?: string;
  }>
): CredentialProvisioningReceipt => {
  try {
    if (receipt.version !== CREDENTIAL_PROVISIONING_RECEIPT_VERSION
      || receipt.phases.length !== 2
      || receipt.phases[0] !== "author"
      || receipt.phases[1] !== "grant") fail();
    const credentials = receipt.credentials.map((credential) => Object.freeze({
      env: credential.env,
      name: credential.name,
      scope: credential.scope,
      source_handle: parseTargetSecretSourceOpaqueHandle(credential.source_handle)
    }));
    const envFileDigest = outputs.env_file_digest === undefined
      ? undefined
      : digest(outputs.env_file_digest);
    const worldBindingsDigest = outputs.world_bindings_digest === undefined
      ? undefined
      : digest(outputs.world_bindings_digest);
    const phases: CredentialProvisioningPhase[] = ["author", "grant"];
    if (outputs.model_engine_auth === true) phases.push("model_engine_auth");
    if (envFileDigest !== undefined) phases.push("env_file");
    if (worldBindingsDigest !== undefined) phases.push("world_bindings");
    return Object.freeze({
      credentials: Object.freeze(credentials),
      ...(envFileDigest === undefined ? {} : { env_file_digest: envFileDigest }),
      phases: Object.freeze(phases),
      run_id: receipt.run_id,
      scope: receipt.scope,
      version: CREDENTIAL_PROVISIONING_RECEIPT_VERSION,
      ...(worldBindingsDigest === undefined ? {} : { world_bindings_digest: worldBindingsDigest })
    });
  } catch {
    return fail();
  }
};
