import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { DAIMON_GROK_BROKER_MODELS, DAIMON_GROK_BROKER_REASONING_EFFORTS, DAIMON_GROK_ENGINE_BROKER } from "./contractManifest.js";
import { DAIMON_GROK_WORKER_CONFIG_BYTES, DAIMON_GROK_WORKER_PROFILE_SAMPLES } from "./grokWorkerConfigBytes.js";
import { renderDaimonGrokWorkerSandboxProfile, resolveDaimonGrokWorkerConfig } from "./grokWorkerContract.js";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

describe("vendored Daimon Grok worker contract", () => {
  it("serves Daimon's renderer bytes for every declared model x effort, each matching the manifest pin", () => {
    for (const model of DAIMON_GROK_BROKER_MODELS) {
      for (const effort of DAIMON_GROK_BROKER_REASONING_EFFORTS) {
        const resolved = resolveDaimonGrokWorkerConfig(model, effort);
        expect(resolved.bytes).toBe(DAIMON_GROK_WORKER_CONFIG_BYTES[model][effort]);
        expect(sha256(resolved.bytes)).toBe(DAIMON_GROK_ENGINE_BROKER.worker.configSha256[model][effort]);
        expect(resolved.bytes).toContain(`model = "${model}"`);
        expect(resolved.bytes).toContain(`value = "${effort}"`);
      }
    }
  });

  it("refuses config bytes that differ from the manifest pin by a single byte", () => {
    const tampered = {
      ...DAIMON_GROK_WORKER_CONFIG_BYTES,
      "grok-4.6": { ...DAIMON_GROK_WORKER_CONFIG_BYTES["grok-4.6"], low: DAIMON_GROK_WORKER_CONFIG_BYTES["grok-4.6"].low.replace("grok-4.6", "grok-4.5") }
    };
    expect(() => resolveDaimonGrokWorkerConfig("grok-4.6", "low", tampered)).toThrow(/does not match the contract manifest pin/u);
    const swapped = { ...DAIMON_GROK_WORKER_CONFIG_BYTES, "grok-4.6": { ...DAIMON_GROK_WORKER_CONFIG_BYTES["grok-4.6"], low: DAIMON_GROK_WORKER_CONFIG_BYTES["grok-4.6"].medium } };
    expect(() => resolveDaimonGrokWorkerConfig("grok-4.6", "low", swapped)).toThrow(/manifest pin/u);
  });

  it("renders sandbox profile bytes identical to Daimon's renderer", () => {
    for (const sample of DAIMON_GROK_WORKER_PROFILE_SAMPLES) {
      expect(renderDaimonGrokWorkerSandboxProfile(sample.denyPaths)).toBe(sample.bytes);
    }
    for (const unsafe of ["relative/path", "/", "/trailing/", "/a/../b", "/quote\"d", "/glob*"]) {
      expect(() => renderDaimonGrokWorkerSandboxProfile([unsafe])).toThrow(/deny path/u);
    }
  });
});
