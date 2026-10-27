import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// Historical bytes, unchanged: v5 a483f6e4, v6 bf61e6bb.
export const daimonImageManifestBytes = (version: 5 | 6 | 7 = 7): Buffer =>
  readFileSync(new URL(version === 7 ? "../runtime/daimon/contract-manifest.json"
    : `./daimon-contract-v${version}.fixture.json`, import.meta.url));

export const daimonImageContractFiles = (bytes = daimonImageManifestBytes()): Record<string, Buffer> => {
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const root = "/opt/spawnfile/runtime-installs/daimon";
  return {
    [`${root}/contract-manifest.json`]: bytes,
    [`${root}/contract-manifest.sha256`]: Buffer.from(`${digest}\n`),
    [`${root}/capability-receipt.json`]: Buffer.from(JSON.stringify({
      version: "spawnfile.daimon-runtime-capability-receipt.v1", manifest_sha256: digest
    }))
  };
};
