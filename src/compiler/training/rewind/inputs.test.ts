import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTrainingProject, resolveTrainingPlan } from "../plan/index.js";
import {
  agentManifest, cleanTrainingProjects, dataFiles, example, memory, network, surfaces, target,
  teamFiles, teamManifest, training, trainingProject, volume, writeTrainingFile
} from "../plan/fixtures.test-helper.js";
import { resolveRewindInputs } from "./inputs.js";

afterEach(cleanTrainingProjects);
afterEach(() => vi.restoreAllMocks());
const resolve = async (root: string, agent = "agent:a") => {
  const project = await loadTrainingProject(root);
  return { project, plan: resolveTrainingPlan(project, agent, "test") };
};
const identity = ({ section, id, declaredBy }: { section: string; id: string; declaredBy: string }) => ({ section, id, declaredBy });

describe("effective rewind inputs", () => {
  it("includes every resource kind, accessible bank and attached network with P2 declaring identities", async () => {
    const root = await trainingProject(teamFiles());
    await writeTrainingFile(root, "a/Spawnfile", agentManifest({ name: "a", training: undefined, surfaces, memory: [memory],
      workspace: { docs: { system: "AGENTS.md" }, resources: [
        { id: "source", kind: "git", url: "./local-repo", mount: "./source", mode: "readonly" },
        { id: "bundle", kind: "bundle", source: "./local.tar", mount: "./bundle", mode: "readonly" }
      ] }
    }));
    const { plan, project } = await resolve(root), before = structuredClone(project);
    // All source files are gone: this is a pure projection of already loaded facts.
    await rm(root, { recursive: true, force: true });
    const clock = vi.spyOn(Date, "now").mockImplementation(() => { throw Error("clock read"); });
    const first = resolveRewindInputs(plan, project, example.id);
    expect(first.at).toBe("2026-10-09T08:20:31Z");
    expect(first.inputs.map(identity)).toEqual([
      { section: "memory", id: "self", declaredBy: "agent:a" },
      { section: "memory", id: "team-memory", declaredBy: "team:publication" },
      { section: "networks", id: "news", declaredBy: "team:publication" },
      { section: "resources", id: "bundle", declaredBy: "agent:a" },
      { section: "resources", id: "source", declaredBy: "agent:a" },
      { section: "resources", id: "edition-state", declaredBy: "team:publication" }
    ]);
    expect(first.inputs.every((input) => !input.overridden)).toBe(true);
    expect(resolveRewindInputs(plan, project, `train:${example.id}`)).toEqual(first);
    expect(project).toEqual(before); expect(clock).not.toHaveBeenCalled();
  });

  it("replaces whole declarations from the loaded dataset and retains inherited identity", async () => {
    const root = await trainingProject(teamFiles());
    const resourceOverride = { ...volume, mount: "./fresh" };
    const memoryOverride = { ...memory, id: "team-memory" };
    const networkOverride = { id: network.id, provider: "moltnet", rooms: [{ id: "assignment", members: ["a", "b"] }] };
    await writeTrainingFile(root, "training/train.yaml", { examples: [{ ...example,
      resources: [resourceOverride], memory: [memoryOverride], networks: [networkOverride]
    }] });
    const { plan, project } = await resolve(root), before = structuredClone(project);
    const result = resolveRewindInputs(plan, project, example.id);
    const replacements = result.inputs.filter((input) => input.overridden);
    expect(replacements).toHaveLength(3);
    for (const [section, declaration] of [["resources", resourceOverride], ["memory", memoryOverride], ["networks", networkOverride]] as const) {
      expect(replacements.find((input) => input.section === section)).toEqual({ section, id: declaration.id,
        declaredBy: "team:publication", declaration, overridden: true, declarationBase: path.join(root, "training") });
    }
    expect(result.inputs.find((input) => input.id === "self")).toMatchObject({ overridden: false, declaredBy: "agent:a" });
    expect(project).toEqual(before);
  });

  it("deduplicates multiple access slots by bank source, without collapsing distinct same-id banks", async () => {
    const root = await trainingProject(teamFiles());
    await writeTrainingFile(root, "Spawnfile", teamManifest({ networks: undefined, memory: [memory],
      shared: { training: { ...training, targets: [] } }, members: [{ id: "a", ref: "a" }, { id: "alias", ref: "a" }] }));
    await writeTrainingFile(root, "a/Spawnfile", agentManifest({ name: "a", memory: [memory], training: {
      targets: [{ ...target, datasets: { train: "../training/train.yaml", test: "../training/test.yaml" } }]
    } }));
    const { plan, project } = await resolve(root);
    const agent = project.compilePlan.nodes.find((node) => node.id === "agent:a")!;
    expect(agent.value.kind).toBe("agent");
    if (agent.value.kind !== "agent") throw Error("expected agent");
    expect(agent.value.memoryAccess!.filter((entry) => entry.declaringKind === "team")).toHaveLength(2);
    expect(resolveRewindInputs(plan, project, example.id).inputs.map(identity)).toEqual([
      { section: "memory", id: "self", declaredBy: "agent:a" },
      { section: "memory", id: "self", declaredBy: "team:publication" }
    ]);
  });

  it("includes representative attachments synthesized from a parent team's network", async () => {
    const root = await trainingProject({ ...dataFiles,
      Spawnfile: teamManifest({ shared: undefined, memory: undefined,
        networks: [{ ...network, rooms: [{ id: "assignment", members: ["child"] }] }], members: [{ id: "child", ref: "child" }] }),
      "child/Spawnfile": teamManifest({ name: "child", shared: undefined, networks: undefined, memory: undefined,
        members: [{ id: "writer", ref: "writer" }] }),
      ...Object.fromEntries(Object.entries(dataFiles).map(([name, value]) => [`child/writer/${name}`, value])),
      "child/writer/Spawnfile": agentManifest()
    });
    const { plan, project } = await resolve(root, "agent:writer");
    expect(resolveRewindInputs(plan, project, example.id).inputs.map(identity)).toEqual([
      { section: "networks", id: "news", declaredBy: "team:publication" }
    ]);
  });

  it("excludes inaccessible banks and unattached networks", async () => {
    const root = await trainingProject(teamFiles());
    await writeTrainingFile(root, "Spawnfile", teamManifest({ memory: [{ ...memory, id: "private", access: { members: ["b"] } }] }));
    await writeTrainingFile(root, "a/Spawnfile", agentManifest({ name: "a", training: undefined, memory: [memory] }));
    const { plan, project } = await resolve(root);
    expect(resolveRewindInputs(plan, project, example.id).inputs.map(identity)).toEqual([
      { section: "memory", id: "self", declaredBy: "agent:a" },
      { section: "resources", id: "edition-state", declaredBy: "team:publication" }
    ]);
  });

  it("accepts equivalent loaded instants and refuses stale or missing example data", async () => {
    const root = await trainingProject({ ...dataFiles, Spawnfile: agentManifest() });
    const { plan, project } = await resolve(root, "agent:writer");
    const raw = project.datasets[path.join(root, "training/train.yaml")]!.value.examples[0]!;
    raw.at = "2026-10-09T08:20:31Z";
    expect(resolveRewindInputs(plan, project, example.id).at).toBe(raw.at);
    raw.at = "2026-10-09T08:20:31.001Z";
    expect(() => resolveRewindInputs(plan, project, example.id)).toThrow(/Loaded example disagrees with plan/u);
    delete project.datasets[path.join(root, "training/train.yaml")];
    expect(() => resolveRewindInputs(plan, project, example.id)).toThrow(/Loaded example disagrees with plan/u);
  });
});
