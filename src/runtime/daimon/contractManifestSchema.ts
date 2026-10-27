import { z } from "zod";

import manifest from "./contract-manifest.json" with { type: "json" };
import { daimonEngineDescriptorsSchema } from "./engineDescriptorSchema.js";

export const DAIMON_CONTRACT_MANIFEST_V6_VERSION = "noopolis.daimon.runtime-contract-manifest.v6" as const;

/** v6 retains every v5 section. Embedded protocol schemas remain JSON data. */
export const daimonContractManifestV6Schema = z.strictObject({
  ...Object.fromEntries(Object.keys(manifest).filter((key) => key !== "codexSubscriptionRealm").map((key) => [key, z.json()])),
  version: z.literal(DAIMON_CONTRACT_MANIFEST_V6_VERSION),
  engines: daimonEngineDescriptorsSchema,
  supportedEngineKinds: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/u)).min(1),
  consumedConfigFields: z.array(z.string()).min(1),
  wakeMoments: z.json().optional()
});

/** Structural schema; the parser additionally checks ABI and cross-section parity. */
export const DAIMON_CONTRACT_MANIFEST_V6_JSON_SCHEMA = {
  ...z.toJSONSchema(daimonContractManifestV6Schema),
  $id: DAIMON_CONTRACT_MANIFEST_V6_VERSION
};

export const DAIMON_CONTRACT_MANIFEST_V7_VERSION = "noopolis.daimon.runtime-contract-manifest.v7" as const;
export const daimonContractManifestV7Schema = daimonContractManifestV6Schema.extend({
  version: z.literal(DAIMON_CONTRACT_MANIFEST_V7_VERSION),
  codexSubscriptionRealm: z.json()
});
export const DAIMON_CONTRACT_MANIFEST_V7_JSON_SCHEMA = {
  ...z.toJSONSchema(daimonContractManifestV7Schema),
  $id: DAIMON_CONTRACT_MANIFEST_V7_VERSION
};
