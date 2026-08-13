import { createHash } from "node:crypto";
import { open, unlink } from "node:fs/promises";

import type { CredentialProvisioningReceipt } from "./credentialProvisioningReceipt.js";
import type { ProvisionedCredentialMaterials } from "./credentialProvisioning.js";
import { TARGET_SECRET_SOURCE_ERROR } from "./targetSecretSourceRecordCommon.js";

export type ProvisionedEnvFileResult = Readonly<{ digest: string; path: string }>;

const fail = (): never => { throw new Error(TARGET_SECRET_SOURCE_ERROR); };

export const writeProvisionedEnvFile = async (input: Readonly<{
  materials: ProvisionedCredentialMaterials;
  path: string;
  receipt: CredentialProvisioningReceipt;
}>): Promise<ProvisionedEnvFileResult> => {
  let bytes: Uint8Array | undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    const credentials = [...input.receipt.credentials].sort((left, right) =>
      left.env < right.env ? -1 : left.env > right.env ? 1 : 0);
    if (credentials.length === 0 || input.materials.size !== credentials.length) fail();
    const prefixes = credentials.map(({ env }) => new TextEncoder().encode(`${env}=`));
    try {
      const size = credentials.reduce((total, credential, index) => {
        const prefix = prefixes[index] ?? fail();
        const material = input.materials.get(credential.name) ?? fail();
        if (!material || material.length === 0 || material.some((byte) => byte === 0 || byte === 10 || byte === 13)) fail();
        return total + prefix.length + material.length + 1;
      }, 0);
      bytes = new Uint8Array(size);
      let offset = 0;
      for (const [index, credential] of credentials.entries()) {
        const prefix = prefixes[index] ?? fail();
        const material = input.materials.get(credential.name) ?? fail();
        bytes.set(prefix, offset);
        offset += prefix.length;
        bytes.set(material, offset);
        offset += material.length;
        bytes[offset] = 10;
        offset += 1;
      }
    } finally {
      for (const prefix of prefixes) prefix.fill(0);
    }
    handle = await open(input.path, "wx", 0o600);
    created = true;
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    await handle.close();
    handle = undefined;
    return Object.freeze({ digest, path: input.path });
  } catch {
    await handle?.close().catch(() => undefined);
    handle = undefined;
    if (created) await unlink(input.path).catch(() => undefined);
    return fail();
  } finally {
    bytes?.fill(0);
    await handle?.close().catch(() => undefined);
  }
};
