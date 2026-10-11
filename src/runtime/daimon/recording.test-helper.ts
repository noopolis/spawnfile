import { readFileSync } from "node:fs";
import { parseDaimonContractManifest, type DaimonContractManifest } from "./contractManifest.js";
import { DAIMON_WAKE_MOMENTS } from "./wakeMoments.js";

/** Capability fixture only: never writes or re-pins the packaged manifest. */
export const capableDaimonManifest = (): DaimonContractManifest => {
  const manifest = JSON.parse(readFileSync(new URL("./contract-manifest.json", import.meta.url), "utf8"));
  return parseDaimonContractManifest({
    ...manifest, wakeMoments: DAIMON_WAKE_MOMENTS,
    consumedConfigFields: [...manifest.consumedConfigFields, DAIMON_WAKE_MOMENTS.configField]
  });
};
