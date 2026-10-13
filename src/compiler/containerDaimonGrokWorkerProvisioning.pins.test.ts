import crypto from "node:crypto";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

import { DAIMON_GROK_BROKER_MODELS, DAIMON_GROK_BROKER_REASONING_EFFORTS } from "../runtime/daimon/contractManifest.js";
import { resolveDaimonGrokWorkerConfig } from "../runtime/daimon/grokWorkerContract.js";
import { renderDaimonGrokWorkerProvisioning } from "./containerDaimonGrokWorkerProvisioning.js";
import type { DaimonGrokRegistration } from "./containerDaimonGrokWorkerRender.js";
import { renderTrainingBrokerProvisioning, renderTrainingSlotProvisioning } from "./training/broker/provisioning.js";
import { resolveTrainingGrokRegistration } from "./training/broker/registration.js";

const registration = (slot: number) => resolveTrainingGrokRegistration({
  agentId: "agent", model: "grok-4.6", reasoningEffort: "low", slot, slots: 4
});

// Run the actual emitted guard, stopping before filesystem provisioning begins.
const executeGuard = (lines: string[]): void => {
  lines = lines.flatMap(line => line.split("\n"));
  const start = lines.findIndex(line => line.startsWith("const grokWorkers ="));
  const end = lines.findIndex(line => line.includes("contract bytes for"));
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  vm.runInNewContext(lines.slice(start, end + 1).join("\n"), { crypto });
};
const guard = (entries: DaimonGrokRegistration[]) => executeGuard(renderDaimonGrokWorkerProvisioning(entries));
const reject = (entry: DaimonGrokRegistration) => expect(() => guard([entry])).toThrow(/do not match their pins/u);

describe("generated Grok configuration pin guard", () => {
  it("accepts all four clocked slots at startup and during individual recycle", () => {
    const entries = [0, 1, 2, 3].map(registration);
    executeGuard(renderTrainingBrokerProvisioning(entries));
    for (const entry of entries) executeGuard(renderTrainingSlotProvisioning(entry));
  });

  it("accepts each declared model and effort with a nonzero clock slot", () => {
    for (const model of DAIMON_GROK_BROKER_MODELS) for (const reasoningEffort of DAIMON_GROK_BROKER_REASONING_EFFORTS) {
      guard([resolveTrainingGrokRegistration({ agentId: "agent", model, reasoningEffort, slot: 7, slots: 8 })]);
    }
  });

  it("rejects modified bytes even with a matching caller-supplied digest", () => {
    const entry = registration(2);
    const config = `${entry.config}\n# tampered\n`;
    reject({ ...entry, config });
    reject({ ...entry, config, configSha256: crypto.createHash("sha256").update(config).digest("hex") });
    reject({ ...entry, configSha256: "0".repeat(64) });
  });

  it("rejects another slot's valid bytes and another model or effort", () => {
    const entry = registration(2);
    const other = registration(1);
    reject({ ...entry, config: other.config, configSha256: other.configSha256 });
    reject({ ...entry, model: "grok-4.5" });
    reject({ ...entry, reasoningEffort: "high" });
  });

  it("rejects unclocked bytes for a clocked registration", () => {
    const entry = registration(0);
    const unclocked = resolveDaimonGrokWorkerConfig(entry.model, entry.reasoningEffort);
    reject({ ...entry, config: unclocked.bytes, configSha256: unclocked.sha256 });
  });

  it("keeps unclocked registrations compatible and rejects clocked bytes under that variant", () => {
    const entry = { ...registration(0), configVariant: undefined };
    reject(entry);
    const unclocked = resolveDaimonGrokWorkerConfig(entry.model, entry.reasoningEffort);
    guard([{ ...entry, config: unclocked.bytes, configSha256: unclocked.sha256 }]);
  });
});
