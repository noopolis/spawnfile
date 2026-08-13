import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { writeProvisionedEnvFile } from "./credentialEnvFile.js";
import type { CredentialProvisioningReceipt } from "./credentialProvisioningReceipt.js";
import type { ProvisionedCredentialMaterials } from "./credentialProvisioning.js";
import { TARGET_SECRET_SOURCE_ERROR } from "./targetSecretSourceRecordCommon.js";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((entry) => rm(entry, { recursive: true, force: true }))));
const receipt = (): CredentialProvisioningReceipt => ({
  credentials: [
    { env: "Z_TOKEN", name: "z-token", scope: "world", source_handle: `opaque_${"a".repeat(16)}` as never },
    { env: "A_CONFIG", name: "a-config", scope: "world", source_handle: `opaque_${"b".repeat(16)}` as never }
  ],
  phases: ["author", "grant"],
  run_id: "run-1",
  scope: "world",
  version: "spawnfile.auth.credential-provisioning.receipt.v1"
});
const materials = (): ProvisionedCredentialMaterials => new Map([
  ["z-token", new TextEncoder().encode("TOKEN_SENTINEL")],
  ["a-config", new TextEncoder().encode('{"key":"CONFIG_SENTINEL"}')]
]);

describe("provisioned env file", () => {
  it("creates one exclusive 0600 file in stable env order and returns its digest", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-env-"));
    cleanup.push(directory);
    const file = path.join(directory, "credentials.env");
    const table = materials();
    const result = await writeProvisionedEnvFile({ materials: table, path: file, receipt: receipt() });
    expect(await readFile(file, "utf8")).toBe(
      'A_CONFIG={"key":"CONFIG_SENTINEL"}\nZ_TOKEN=TOKEN_SENTINEL\n'
    );
    expect(result).toEqual({
      digest: "sha256:25cca03773f68fd62ec159155575836936e9c514cab4e9ab12216214f63d08e6",
      path: file
    });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(new TextDecoder().decode(table.get("z-token"))).toBe("TOKEN_SENTINEL");
  });

  it("never overwrites or removes a pre-existing path", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-env-existing-"));
    cleanup.push(directory);
    const file = path.join(directory, "credentials.env");
    await writeFile(file, "existing", { mode: 0o600 });
    await expect(writeProvisionedEnvFile({
      materials: materials(),
      path: file,
      receipt: receipt()
    })).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(await readFile(file, "utf8")).toBe("existing");
  });

  it("rejects missing, empty, or line-breaking materials without creating a file", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-env-invalid-"));
    cleanup.push(directory);
    for (const [index, table] of [
      new Map([["z-token", new Uint8Array()], ["a-config", new TextEncoder().encode("{}")]]),
      new Map([["z-token", new TextEncoder().encode("line\nbreak")], ["a-config", new TextEncoder().encode("{}")]]),
      new Map([["z-token", new TextEncoder().encode("present")]])
    ].entries()) {
      const file = path.join(directory, `credentials-${index}.env`);
      await expect(writeProvisionedEnvFile({
        materials: table,
        path: file,
        receipt: receipt()
      })).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
      await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});
