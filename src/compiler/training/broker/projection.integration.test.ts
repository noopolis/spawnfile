import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { DAIMON_GROK_ENGINE_BROKER } from "../../../runtime/daimon/contractManifest.js";
import { parseTrainingBrokerDeclaration } from "./declaration.js";
import { trainingSlotDescriptors } from "./paths.js";
import { resolveTrainingGrokRegistration } from "./registration.js";
import { resolveTrainingGrokProjection, type DaimonProjectionModule } from "./projection.js";
import { buildTrainingSlotReceipt } from "./receipt.js";
import { DAIMON_GROK_WORKER_SKILLS_SAMPLES } from "../../../runtime/daimon/grokWorkerConfigBytes.js";
import { renderDaimonGrokServiceConfig } from "../../containerDaimonGrokWorkerRender.js";

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

  it("binds declared skills exactly as Daimon's projection, service parser and pre-turn attestation do", async () => {
    const [projectionApi, serviceApi, homeApi, skillsApi] = await Promise.all([
      load("src/runtime/grokBrokerProjection.ts"), load("src/runtime/engineBrokerServiceConfig.ts"),
      load("src/runtime/grokWorkerHomeAttestation.ts"), load("src/runtime/grokWorkerSkills.ts")
    ]);
    const daimon = { ...projectionApi, GROK_ENGINE_BROKER: DAIMON_GROK_ENGINE_BROKER } as DaimonProjectionModule;
    const skills = DAIMON_GROK_WORKER_SKILLS_SAMPLES[2]!.skills.map((skill) => ({ name: skill.name, files: skill.files.map((file) => ({ ...file })) }));
    const declaration = parseTrainingBrokerDeclaration({ version: "spawnfile.training-broker.v2", slots: 2, engine: "grok", agentId: "agent:author",
      model: "grok-4.6", reasoningEffort: "low", architecture: "arm64", limits: { maxRequests: 4, maxTokens: 100, timeoutMs: 1000 }, organizationUid: 2000,
      bootstrap: "/var/lib/spawnfile/daimon/grok-bootstrap-auth", seccompProfileSha256: "a".repeat(64), skills });
    const registrations = [0, 1].map((slot) => resolveTrainingGrokRegistration({ ...declaration, slot }));
    for (const registration of registrations) {
      const { projection } = await resolveTrainingGrokProjection(declaration, registration, daimon);
      expect(projection.skillsSha256).toBe(skillsApi.grokWorkerSkillsSha256(skills));
      expect(projection.skillsSha256).toBe(registration.skills!.sha256);
      expect(registration.skills!.tree).toEqual(skillsApi.renderGrokWorkerSkillsTree(skills));
    }
    const service = renderDaimonGrokServiceConfig(registrations, { version: "v3" });
    const parsed = serviceApi.parseEngineBrokerServiceConfig(service) as { slotPolicies?: { skillsSha256?: string }[] };
    expect(JSON.stringify(parsed)).toContain(registrations[0]!.skills!.sha256);
    // The tree as provisioning writes it passes the broker's own pre-turn attestation (owner = this uid).
    const grokHome = mkdtempSync(path.join(process.env.TMPDIR ?? "/private/tmp", "grok-home-"));
    try {
      const directories: [string, number][] = [];
      for (const entry of registrations[0]!.skills!.tree) {
        const target = path.join(grokHome, entry.path);
        if (entry.kind === "directory") { mkdirSync(target, { mode: 0o700 }); directories.push([target, entry.mode]); }
        else { writeFileSync(target, entry.content!, { flag: "wx", mode: 0o600 }); chmodSync(target, entry.mode); }
      }
      for (const [target, mode] of directories.reverse()) chmodSync(target, mode);
      await expect(homeApi.verifyGrokWorkerSkills(grokHome, registrations[0]!.skills!.sha256, process.getuid!())).resolves.toBeUndefined();
      await expect(homeApi.verifyGrokWorkerSkills(grokHome, "0".repeat(64), process.getuid!())).rejects.toThrow();
    } finally {
      const restore = (target: string): void => { try { chmodSync(target, 0o700); } catch { /* absent */ } };
      for (const entry of registrations[0]!.skills!.tree) if (entry.kind === "directory") restore(path.join(grokHome, entry.path));
      rmSync(grokHome, { recursive: true, force: true });
    }
  });
});
