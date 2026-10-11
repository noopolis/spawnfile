import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import { DAIMON_CONTRACT_MANIFEST_SHA256, parseDaimonContractManifest, type DaimonContractManifest } from "./contractManifest.js";
import { DAIMON_WAKE_MOMENTS } from "./wakeMoments.js";

/** Capability fixture only: never writes or re-pins the packaged manifest. */
export const capableDaimonManifest = (): DaimonContractManifest => {
  const manifest = JSON.parse(readFileSync(new URL("./contract-manifest.json", import.meta.url), "utf8"));
  return parseDaimonContractManifest({
    ...manifest, wakeMoments: DAIMON_WAKE_MOMENTS,
    consumedConfigFields: [...new Set([...manifest.consumedConfigFields, DAIMON_WAKE_MOMENTS.configField])]
  });
};

/** Explicit test-only image authority; callers restore stubbed env and remove their fixture root. */
export const useMatchingDaimonTestImage = (directory: string): void => {
  const identity = path.join(directory, "daimon-test-identity.json"), digest = `sha256:${"a".repeat(64)}`;
  writeFileSync(identity, JSON.stringify({
    capability_receipt_sha256: digest,
    development: { mode: "local-development", non_production: true, unpublished: true, unsigned: true },
    image_architecture: "amd64", image_config_digest: digest, image_manifest_digest: digest,
    image_reference: `127.0.0.1:54321/noopolis/spawnfile-runtime-daimon@${digest}`,
    manifest_sha256: DAIMON_CONTRACT_MANIFEST_SHA256, registry_authority: "127.0.0.1:54321",
    version: "spawnfile.local-daimon-runtime-identity.v3"
  }));
  vi.stubEnv("SPAWNFILE_DAIMON_LOCAL_RUNTIME_IDENTITY", identity);
};
