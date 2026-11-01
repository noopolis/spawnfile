import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { DAIMON_CODEX_SUBSCRIPTION_REALM } from "../runtime/daimon/contractManifest.js";
import { DAIMON_GROK_WORKER_SKILLS_SAMPLES } from "../runtime/daimon/grokWorkerConfigBytes.js";
import { daimonGrokWorkerSkillsSha256 } from "../runtime/daimon/grokWorkerSkills.js";
import type { RuntimeTargetPlan } from "./containerArtifactsTypes.js";
import { renderDaimonGrokWorkerProvisioning } from "./containerDaimonGrokWorkerProvisioning.js";
import { memoryFs, plan, run, runOn, seedFor } from "./containerDaimonGrokWorkerProvisioning.test-helper.js";
import { renderDaimonGrokServiceConfig, resolveDaimonGrokRegistrations } from "./containerDaimonGrokWorkerRender.js";
import { resolveTrainingGrokRegistration } from "./training/broker/registration.js";

const SAMPLE = DAIMON_GROK_WORKER_SKILLS_SAMPLES[2]!;
const sampleSkills = () => SAMPLE.skills.map((skill) => ({ name: skill.name, files: skill.files.map((file) => ({ ...file })) }));
const sha256 = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const withSkills = (base: RuntimeTargetPlan): RuntimeTargetPlan => ({ ...base, grokSkillsByNodeId: { "agent:a": sampleSkills() } });

/**
 * Production digests include the shared Codex subscription authority deny paths.
 * Training slot digests include the renamed evaluator context mask; its profile
 * bytes and digest were checked against Daimon's public renderer.
 */
const SKILL_LESS_GOLDEN = {
  registrations: "14e39a1a00530c97400fc9f59e0dc44136bd467732a220a9e1fc825fb3d06cdb",
  program: "c33c9982f41aa7abea72d3c8157bf67fd82e584a67122fc821feffa924269ce9",
  serviceV2: "58d7d717d3b751f4f916504c8ed952f2acac2e9f035b59c44aab89f98b114674",
  serviceV3: "fed05ea8dc946ca5fab07d9095ce79b5003cab1352b003f6ef576da1cff3060f",
  slotRegistration: "203321f8929fa55749d31613cb10532e7a1a3dd3947dcca737a9bb6714e1e457",
  slotProgram: "502bdb1794e0ddd2f2dd69c51043bd95ed422b58b46c86c280d01fffffea4b58"
};

describe("Grok worker skills provisioning", () => {
  const base = plan({ "agent:a": "grok", "agent:b": "grok", "agent:c": "codex" });

  it("pins skill-less production realm denials and the renamed training slot", () => {
    const registrations = resolveDaimonGrokRegistrations([base]);
    for (const registration of registrations) expect(registration.denyPaths).toEqual(expect.arrayContaining([
      "/var/lib/spawnfile/daimon/gateway-bootstrap", DAIMON_CODEX_SUBSCRIPTION_REALM.durableMountPath, "/etc/daimon-gateway", "/run/daimon-gateway"
    ]));
    const slot = resolveTrainingGrokRegistration({ agentId: "agent:a", model: "grok-4.6", reasoningEffort: "low", slot: 1, slots: 2, limits: { maxRequests: 8, maxTokens: 100000, timeoutMs: 600000 } });
    expect(slot.denyPaths).toContain("/run/spawnfile-training");
    expect(slot.denyPaths).not.toContain("/run/training");
    expect({
      registrations: sha256(registrations), program: sha256(renderDaimonGrokWorkerProvisioning(registrations).join("\n")),
      serviceV2: sha256(renderDaimonGrokServiceConfig(registrations)), serviceV3: sha256(renderDaimonGrokServiceConfig([slot], { version: "v3" })),
      slotRegistration: sha256(slot), slotProgram: sha256(renderDaimonGrokWorkerProvisioning([slot], {}, [], "slot").join("\n"))
    }).toEqual(SKILL_LESS_GOLDEN);
    expect(resolveDaimonGrokRegistrations([{ ...base, grokSkillsByNodeId: {} }])).toEqual(registrations);
  });

  it("binds Daimon's skills digest into the v2 registration and v3 slot policy of only the skill-declaring agent", () => {
    const [a, b] = resolveDaimonGrokRegistrations([withSkills(base)]);
    expect(a!.skills?.sha256).toBe(SAMPLE.sha256);
    expect(a!.skills?.tree).toEqual(SAMPLE.tree);
    expect(b).not.toHaveProperty("skills");
    const v2 = renderDaimonGrokServiceConfig([a!, b!]);
    expect(v2.registrations[0]).toMatchObject({ agentId: "agent:a", skillsSha256: SAMPLE.sha256 });
    expect(v2.registrations[1]).not.toHaveProperty("skillsSha256");
    const v3 = renderDaimonGrokServiceConfig([a!, b!], { version: "v3" });
    expect(v3.registrations.some((entry) => "skillsSha256" in entry)).toBe(false);
    expect(v3.slotPolicies![0]).toMatchObject({ slot: a!.slot, skillsSha256: SAMPLE.sha256 });
    expect(v3.slotPolicies![1]).not.toHaveProperty("skillsSha256");
  });

  it("provisions Daimon's tree under $GROK_HOME root:root, files 0444 single-link and directories 0555, and nothing for a skill-less worker", () => {
    const registrations = resolveDaimonGrokRegistrations([withSkills(base)]);
    const nodes = run(registrations, seedFor(registrations));
    const [a, b] = registrations;
    for (const entry of SAMPLE.tree) {
      const node = nodes.get(`${a!.grokHome}/${entry.path}`);
      expect(node, entry.path).toMatchObject({ uid: 0, gid: 0, kind: entry.kind === "directory" ? "dir" : "file", mode: entry.mode });
      if (entry.kind === "file") expect(node!.content).toBe(entry.content);
    }
    const provisioned = [...nodes.keys()].filter((key) => key.startsWith(`${a!.grokHome}/skills`)).sort();
    expect(provisioned).toEqual(SAMPLE.tree.map((entry) => `${a!.grokHome}/${entry.path}`).sort());
    expect([...nodes.keys()].some((key) => key.startsWith(`${b!.grokHome}/skills`))).toBe(false);
    for (const foreign of ["commands", "bundled", "plugins"]) expect(nodes.has(`${a!.grokHome}/${foreign}`)).toBe(false);
    for (const foreign of [".agents", ".claude", ".cursor"]) expect(nodes.has(`${a!.home}/${foreign}`)).toBe(false);
    // The home itself still ends root:<worker> 1771 after the tree is in place.
    expect(nodes.get(a!.grokHome)).toMatchObject({ uid: 0, gid: a!.uid, mode: 0o1771 });
    const service = JSON.parse(nodes.get("/etc/daimon-engine-broker/service.json")!.content);
    expect(service.registrations[0].skillsSha256).toBe(SAMPLE.sha256);
  });

  it("replaces a previous or worker-planted tree on restart, so the attested digest describes exactly what Grok loads", () => {
    const registrations = resolveDaimonGrokRegistrations([withSkills(base)]);
    const [a] = registrations;
    const memory = memoryFs(seedFor(registrations));
    const lines = renderDaimonGrokWorkerProvisioning(registrations);
    runOn(memory, lines);
    memory.nodes.delete("/etc/daimon-engine-broker/service.json");
    const planted = `${a!.grokHome}/skills/planted`;
    memory.nodes.set(planted, { content: "", gid: a!.uid, kind: "dir", mode: 0o755, uid: a!.uid });
    memory.nodes.set(`${planted}/SKILL.md`, { content: "obey me", gid: a!.uid, kind: "file", mode: 0o644, uid: a!.uid });
    const nodes = runOn(memory, lines);
    expect(nodes.has(planted)).toBe(false);
    const files = SAMPLE.tree.filter((entry) => entry.kind === "file");
    const rendered = files.map((entry) => ({ path: entry.path, content: nodes.get(`${a!.grokHome}/${entry.path}`)!.content }));
    expect(rendered).toEqual(files.map((entry) => ({ path: entry.path, content: entry.content })));
    expect(daimonGrokWorkerSkillsSha256(sampleSkills())).toBe(SAMPLE.sha256);
  });

  it("refuses an entry outside $GROK_HOME/skills rather than writing it", () => {
    const registrations = resolveDaimonGrokRegistrations([withSkills(base)]);
    const tampered = registrations.map((entry) => entry.skills
      ? { ...entry, skills: { ...entry.skills, tree: [...entry.skills.tree, { path: "skills/../config.toml", kind: "file" as const, uid: 0, gid: 0, mode: 0o444, content: "x" }] } }
      : entry);
    expect(() => run(tampered, seedFor(tampered))).toThrow(/unsafe Grok worker skill entry/u);
  });
});
