import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DAIMON_GROK_ENGINE_BROKER } from "../../../runtime/daimon/contractManifest.js";
import { parseTrainingBrokerDeclaration } from "./declaration.js";
import { loadDaimonProjectionModule, resolveTrainingGrokProjection, type DaimonProjectionModule } from "./projection.js";
import { buildTrainingSlotReceipt } from "./receipt.js";
import { resolveTrainingGrokRegistration } from "./registration.js";

const broker = DAIMON_GROK_ENGINE_BROKER;
const declaration = parseTrainingBrokerDeclaration({
  version: "spawnfile.training-broker.v1", engine: "grok", agentId: "agent:author", model: "grok-4.6", reasoningEffort: "low",
  architecture: "arm64", limits: broker.turnLimits.v1Defaults, bootstrap: "/var/lib/spawnfile/daimon/grok-bootstrap-auth",
  organizationUid: 2000, seccompProfileSha256: "a".repeat(64)
});
const registration = resolveTrainingGrokRegistration(declaration);

/** A resolver that defaults to unclocked, like Daimon: removing the caller's variant must fail. */
const moduleFor = (overrides: Record<string, unknown> = {}): DaimonProjectionModule => ({
  GROK_ENGINE_BROKER: broker,
  resolveOrganizationGrokBrokerProjection: (config, agentId, options) => {
    expect((config as { agents: unknown[] }).agents).toHaveLength(1);
    expect(agentId).toBe(registration.agentId);
    const clocked = options.workerConfigVariant === "clocked";
    return {
      version: broker.projectionVersion, denyPaths: registration.denyPaths, profileSha256: registration.profileSha256,
      workerConfigVariant: clocked ? "clocked" : "unclocked",
      workerConfigSha256: (clocked ? broker.worker.clockedConfigSha256 : broker.worker.configSha256)["grok-4.6"].low,
      ...(clocked ? { taskClock: broker.worker.taskClock } : {}), ...overrides
    };
  },
  grokBrokerProjectionSha256: (projection) => createHash("sha256").update(JSON.stringify(projection)).digest("hex")
});

describe("training clocked projection", () => {
  it("binds the v2 variant and selected config digest into the slot receipt", async () => {
    const daimon = await loadDaimonProjectionModule(async () => moduleFor());
    const result = await resolveTrainingGrokProjection(declaration, registration, daimon);
    expect(result.projection).toMatchObject({ version: "noopolis.daimon.grok-broker-projection.v2",
      workerConfigVariant: "clocked", workerConfigSha256: registration.configSha256, taskClock: broker.worker.taskClock });
    const receipt = buildTrainingSlotReceipt({ slot: 0, workerUid: 2200, generation: 1, nonce: "a".repeat(64),
      projectionSha256: result.projectionSha256, sandboxProfileSha256: registration.profileSha256,
      seccompProfileSha256: declaration.seccompProfileSha256, grokExecutableSha256: broker.grokCliArtifacts.arm64.sha256,
      canaries: [{ path: registration.denyPaths[0]!, method: "sandboxed-read", result: "denied" }], createdAt: new Date(0) });
    expect(receipt.projection_sha256).toBe(daimon.grokBrokerProjectionSha256(result.projection));
    expect(receipt.projection_sha256).not.toBe(daimon.grokBrokerProjectionSha256({ ...result.projection, workerConfigVariant: "unclocked" }));
  });

  it.each([
    { version: "noopolis.daimon.grok-broker-projection.v1" }, { workerConfigVariant: "unclocked" },
    { workerConfigSha256: broker.worker.configSha256["grok-4.6"].low }, { taskClock: undefined },
    { taskClock: { ...broker.worker.taskClock, directoryMode: 0o777 } }, { profileSha256: "b".repeat(64) }
  ])("refuses a mismatched clocked projection: %j", async (overrides) => {
    await expect(resolveTrainingGrokProjection(declaration, registration, moduleFor(overrides))).rejects.toThrow(/clocked worker config/u);
  });

  it("refuses deny-list drift and an unclocked registration", async () => {
    await expect(resolveTrainingGrokProjection(declaration, registration, moduleFor({ denyPaths: [] }))).rejects.toThrow(/deny list differs/u);
    await expect(resolveTrainingGrokProjection(declaration, { ...registration, workerConfigVariant: "unclocked" }, moduleFor())).rejects.toThrow(/clocked worker config/u);
  });

  it.each(["projectionVersion", "controlProtocolVersion", "slotPreflightVersion", "nativeAbiVersion"] as const)("refuses an installed Daimon with an old %s", async (field) => {
    await expect(loadDaimonProjectionModule(async () => ({ ...moduleFor(), GROK_ENGINE_BROKER: { ...broker, [field]: "old" } })))
      .rejects.toThrow(/differs from this compiler/u);
  });
});
