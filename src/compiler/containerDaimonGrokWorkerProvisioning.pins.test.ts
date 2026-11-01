import crypto from "node:crypto";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

import { DAIMON_GROK_BROKER_MODELS, DAIMON_GROK_BROKER_REASONING_EFFORTS } from "../runtime/daimon/contractManifest.js";
import { renderDaimonGrokWorkerProvisioning } from "./containerDaimonGrokWorkerProvisioning.js";
import { plan } from "./containerDaimonGrokWorkerProvisioning.test-helper.js";
import { resolveDaimonGrokRegistrations, type DaimonGrokRegistration } from "./containerDaimonGrokWorkerRender.js";

const registrationFor = (model: string, reasoningEffort: string): DaimonGrokRegistration =>
  resolveDaimonGrokRegistrations([{ ...plan({ agent: "grok" }), grokModelByNodeId: { agent: { model, reasoningEffort } } }])[0]!;
const registration = () => registrationFor("grok-4.6", "low");

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
  it("accepts each declared model and effort", () => {
    for (const model of DAIMON_GROK_BROKER_MODELS) for (const reasoningEffort of DAIMON_GROK_BROKER_REASONING_EFFORTS) {
      guard([registrationFor(model, reasoningEffort)]);
    }
  });

  it("rejects modified bytes even with a matching caller-supplied digest", () => {
    const entry = registration();
    const config = `${entry.config}\n# tampered\n`;
    reject({ ...entry, config });
    reject({ ...entry, config, configSha256: crypto.createHash("sha256").update(config).digest("hex") });
    reject({ ...entry, configSha256: "0".repeat(64) });
  });

  it("rejects another model or effort", () => {
    const entry = registration();
    reject({ ...entry, model: "grok-4.5" });
    reject({ ...entry, reasoningEffort: "high" });
  });
});
