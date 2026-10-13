import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { DAIMON_GROK_ENGINE_BROKER } from "../../../runtime/daimon/contractManifest.js";
import { parseTrainingBrokerDeclaration } from "./declaration.js";
import { trainingSlotDescriptors } from "./paths.js";
import { resolveTrainingGrokRegistration } from "./registration.js";
import { resolveTrainingGrokProjection, type DaimonProjectionModule } from "./projection.js";
import { buildTrainingSlotReceipt } from "./receipt.js";

// Source checkout integration is explicit: no runtime dependency on Daimon and no provider calls.
const source = process.env.SPAWNFILE_DAIMON_SOURCE_DIR;
const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.join(source!, file)).href);

describe.skipIf(!source)("clocked training slots against Daimon's actual contract", () => {
  it("attests every model/effort and slot, and verifies the clocked projection receipt", async () => {
    const [projectionApi, slotApi, configApi, receiptApi] = await Promise.all([
      load("src/runtime/grokBrokerProjection.ts"), load("src/runtime/grokBrokerSlot.ts"),
      load("src/runtime/grokBrokerWorkerConfig.ts"), load("src/runtime/grokSlotPreflightReceipt.ts")
    ]);
    const daimon = { ...projectionApi, GROK_ENGINE_BROKER: DAIMON_GROK_ENGINE_BROKER } as DaimonProjectionModule;
    for (const count of [1, 4, 8]) for (const p of trainingSlotDescriptors(count)) {
      for (const model of DAIMON_GROK_ENGINE_BROKER.worker.models) for (const reasoningEffort of DAIMON_GROK_ENGINE_BROKER.worker.reasoningEfforts) {
        const declaration = parseTrainingBrokerDeclaration({ version: "spawnfile.training-broker.v2", slots: count,
          engine: "grok", agentId: "agent:author", model, reasoningEffort, architecture: "arm64",
          limits: { maxRequests: 4, maxTokens: 100, timeoutMs: 1000 }, organizationUid: 2000,
          bootstrap: "/var/lib/spawnfile/daimon/grok-bootstrap-auth", seccompProfileSha256: "a".repeat(64) });
        const registration = resolveTrainingGrokRegistration({ ...declaration, slot: p.slot });
        slotApi.assertBrokerTaskClockIsolation("clocked", p.slot, trainingSlotDescriptors(count).map(s => s.slot), registration.denyPaths);
        expect(registration.config).toBe(configApi.renderGrokBrokerWorkerConfig({ model, reasoningEffort }, "clocked", p.slot));
        const { projection, projectionSha256 } = await resolveTrainingGrokProjection(declaration, registration, daimon);
        expect(projection.workerConfigVariant).toBe("clocked");
        expect(projection.workerConfigSha256).toBe(registration.configSha256);
        expect(projection.taskClock).toMatchObject({ timestampFilePath: p.clockFile, directoryPath: p.clockDirectory });
        const nonce = "b".repeat(64);
        const receipt = buildTrainingSlotReceipt({ slot: p.slot, workerUid: p.workerUid, generation: 1, nonce,
          projectionSha256, sandboxProfileSha256: registration.profileSha256,
          seccompProfileSha256: declaration.seccompProfileSha256, grokExecutableSha256: projection.grokExecutableSha256 as string,
          canaries: registration.denyPaths.map(path => ({ path, method: "sandboxed-read", result: "denied" })), createdAt: new Date() });
        expect(receiptApi.verifyGrokSlotPreflightReceipt(receipt, projection, { expectedNonce: nonce, minGeneration: 1 })).toEqual(receipt);
        const stale = { ...registration, configSha256: "0".repeat(64) };
        await expect(resolveTrainingGrokProjection(declaration, stale, daimon)).rejects.toThrow(/clocked worker config differs/);
      }
    }
  });
});
