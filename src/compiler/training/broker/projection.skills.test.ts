import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { DAIMON_GROK_ENGINE_BROKER } from "../../../runtime/daimon/contractManifest.js";
import { resolveDaimonGrokClockedWorkerConfig } from "../../../runtime/daimon/grokWorkerContract.js";
import { DAIMON_GROK_WORKER_SKILLS_SAMPLES } from "../../../runtime/daimon/grokWorkerConfigBytes.js";
import { daimonGrokWorkerSkillsSha256, type DaimonAgentSkill } from "../../../runtime/daimon/grokWorkerSkills.js";
import { parseTrainingBrokerDeclaration } from "./declaration.js";
import { resolveTrainingSlotProjection, type DaimonProjectionModule } from "./projection.js";
import { renderTrainingBrokerProvisioning, renderTrainingSlotProvisioning } from "./provisioning.js";

const broker = DAIMON_GROK_ENGINE_BROKER;
const SAMPLE = DAIMON_GROK_WORKER_SKILLS_SAMPLES[2]!;
const skills = (): DaimonAgentSkill[] => SAMPLE.skills.map((skill) => ({ name: skill.name, files: skill.files.map((file) => ({ ...file })) }));
const declarationFor = (withSkills: boolean) => parseTrainingBrokerDeclaration({
  version: "spawnfile.training-broker.v2", slots: 2, engine: "grok", agentId: "agent:author", model: "grok-4.6", reasoningEffort: "low",
  architecture: "arm64", limits: broker.turnLimits.v1Defaults, bootstrap: "/var/lib/spawnfile/daimon/grok-bootstrap-auth",
  organizationUid: 2000, seccompProfileSha256: "a".repeat(64), ...(withSkills ? { skills: skills() } : {})
});

/**
 * Daimon's resolver over the inputs it reads. `skillsAware: false` is Daimon
 * 0.2.1, which ignores `skills`; the received options are recorded.
 */
const daimonModule = (skillsAware = true, seen: Record<string, unknown>[] = []): DaimonProjectionModule => ({
  GROK_ENGINE_BROKER: broker,
  resolveOrganizationGrokBrokerProjection: (_config, _agentId, options) => {
    seen.push(options);
    const slot = options.slot as number, clock = broker.worker.taskClock;
    const declared = options.skills as DaimonAgentSkill[] | undefined;
    return {
      version: broker.projectionVersion, denyPaths: options.denyPaths as string[], profileSha256: options.profileSha256 as string,
      workerConfigVariant: "clocked", workerConfigSha256: resolveDaimonGrokClockedWorkerConfig("grok-4.6", "low", slot).sha256,
      taskClock: { ...clock, directoryPath: clock.slotDirectoryPattern.replace("{slot}", String(slot)), timestampFilePath: clock.slotFilePattern.replace("{slot}", String(slot)) },
      ...(skillsAware && declared?.length ? { skillsSha256: daimonGrokWorkerSkillsSha256(declared) } : {})
    } as unknown as ReturnType<DaimonProjectionModule["resolveOrganizationGrokBrokerProjection"]>;
  },
  grokBrokerProjectionSha256: (projection) => createHash("sha256").update(JSON.stringify(projection)).digest("hex")
});

describe("training slot projection with declared skills", () => {
  it("binds the declaration's skills into the registration, the projection and its digest", async () => {
    const seen: Record<string, unknown>[] = [];
    const skilled = await resolveTrainingSlotProjection(declarationFor(true), 1, daimonModule(true, seen));
    const bare = await resolveTrainingSlotProjection(declarationFor(false), 1, daimonModule());
    expect(skilled.registration.skills).toEqual({ sha256: SAMPLE.sha256, tree: SAMPLE.tree });
    expect(skilled.projection.skillsSha256).toBe(SAMPLE.sha256);
    expect(seen[0]!.skills).toEqual(declarationFor(true).skills);
    expect(skilled.projectionSha256).not.toBe(bare.projectionSha256);
    expect(bare.registration).not.toHaveProperty("skills");
    expect(bare.projection).not.toHaveProperty("skillsSha256");
  });

  it("hands Daimon no skills option at all for a skill-less declaration", async () => {
    const seen: Record<string, unknown>[] = [];
    await resolveTrainingSlotProjection(declarationFor(false), 0, daimonModule(true, seen));
    expect(seen[0]).not.toHaveProperty("skills");
  });

  it("refuses a Daimon that ignores skills, and a projection digest that differs from the provisioned tree", async () => {
    await expect(resolveTrainingSlotProjection(declarationFor(true), 0, daimonModule(false))).rejects.toThrow(/skills digest differs.*>= 0\.2\.2/u);
    const drifted: DaimonProjectionModule = { ...daimonModule(), resolveOrganizationGrokBrokerProjection: (config, agentId, options) =>
      ({ ...daimonModule().resolveOrganizationGrokBrokerProjection(config, agentId, options), skillsSha256: "0".repeat(64) }) };
    await expect(resolveTrainingSlotProjection(declarationFor(true), 0, drifted)).rejects.toThrow(/skills digest differs/u);
  });

  it("provisions the tree on every slot recycle and binds skillsSha256 in each v3 slot policy", async () => {
    const slots = await Promise.all([0, 1].map((slot) => resolveTrainingSlotProjection(declarationFor(true), slot, daimonModule())));
    const shared = renderTrainingBrokerProvisioning(slots.map((slot) => slot.registration)).join("\n");
    const service = JSON.parse(/const service = (.*);$/mu.exec(shared)![1]!) as { slotPolicies: { slot: number; skillsSha256?: string }[] };
    expect(service.slotPolicies.map((policy) => policy.skillsSha256)).toEqual([SAMPLE.sha256, SAMPLE.sha256]);
    for (const { registration } of slots) {
      const recycle = renderTrainingSlotProvisioning(registration).join("\n");
      expect(recycle).toContain("provisionSkills(entry)");
      expect(recycle).toContain(JSON.stringify(SAMPLE.tree[1]!.path));
    }
    const bare = await resolveTrainingSlotProjection(declarationFor(false), 0, daimonModule());
    expect(renderTrainingSlotProvisioning(bare.registration).join("\n")).not.toContain("provisionSkills");
  });
});
