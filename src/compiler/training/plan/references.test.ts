import { afterEach, describe, expect, it } from "vitest";

import { createTrainingPlan, loadTrainingProject } from "./load.js";
import { resolveTrainingResource } from "./references.js";
import { trainingAgents } from "./targets.js";
import {
  agentManifest, cleanTrainingProjects, dataFiles, example, memory, network, surfaces, target,
  teamFiles, teamManifest, training, trainingProject, volume, writeTrainingFile
} from "./fixtures.test-helper.js";

afterEach(cleanTrainingProjects);
const options = { agent: "agent:a", packageVersion: "0.1.17" };

describe("compiled training identities", () => {
  it("resolves inherited resources, permitted team memory, and attached networks to their declaring node", async () => {
    const root = await trainingProject(teamFiles());
    await writeTrainingFile(root, "training/train.yaml", { examples: [{ ...example,
      resources: [volume], memory: [{ ...memory, id: "team-memory" }], networks: [network]
    }] });
    const plan = await createTrainingPlan(root, options);
    expect(plan.targets[0].datasets.train.examples[0].overrides).toEqual([
      { section: "memory", id: "team-memory", declaredBy: "team:publication" },
      { section: "networks", id: "news", declaredBy: "team:publication" },
      { section: "resources", id: "edition-state", declaredBy: "team:publication" }
    ]);
  });

  it.each(["resources", "memory", "networks"] as const)("rejects unknown %s override ids", async (section) => {
    const root = await trainingProject(teamFiles());
    const declaration = section === "resources" ? volume : section === "memory" ? memory : network;
    await writeTrainingFile(root, "training/test.yaml", { examples: [{ ...example, [section]: [{ ...declaration, id: "unknown" }] }] });
    await expect(createTrainingPlan(root, options)).rejects.toThrow(new RegExp(`agent:a ${section}: unknown id unknown`, "u"));
  });

  it("rejects an ambiguous own/team memory id", async () => {
    const root = await trainingProject(teamFiles());
    await writeTrainingFile(root, "Spawnfile", teamManifest({ memory: [memory] }));
    await writeTrainingFile(root, "training/train.yaml", { examples: [{ ...example, memory: [memory] }] });
    await expect(createTrainingPlan(root, options)).rejects.toThrow(/agent:a memory: ambiguous id self/u);
  });

  it("does not count duplicate access slots for the same bank as different items", async () => {
    const root = await trainingProject(teamFiles());
    await writeTrainingFile(root, "Spawnfile", teamManifest({ networks: undefined, shared: { training: { ...training, targets: [] } },
      members: [{ id: "a", ref: "a" }, { id: "alias", ref: "a" }] }));
    await writeTrainingFile(root, "a/Spawnfile", agentManifest({ name: "a", training: {
      targets: [{ ...target, datasets: { train: "../training/train.yaml", test: "../training/test.yaml" } }]
    } }));
    await writeTrainingFile(root, "training/train.yaml", { examples: [{ ...example, memory: [{ ...memory, id: "team-memory" }] }] });
    expect((await createTrainingPlan(root, options)).targets[0].datasets.train.examples[0].overrides)
      .toEqual([{ section: "memory", id: "team-memory", declaredBy: "team:publication" }]);
  });

  it("validates every team consumer even when selecting one with permitted memory access", async () => {
    const root = await trainingProject(teamFiles());
    await writeTrainingFile(root, "Spawnfile", teamManifest({ memory: [{ ...memory, id: "team-memory", access: { members: ["a"] } }] }));
    await writeTrainingFile(root, "training/train.yaml", { examples: [{ ...example, memory: [{ ...memory, id: "team-memory" }] }] });
    await expect(createTrainingPlan(root, options)).rejects.toThrow(/declared by team:publication for agent:b memory: unknown/u);
  });

  it("projects each selected consumer's own declaration for the same override id", async () => {
    const root = await trainingProject(teamFiles());
    await writeTrainingFile(root, "training/train.yaml", { examples: [{ ...example, memory: [memory] }] });
    for (const agent of ["agent:a", "agent:b"]) {
      const plan = await createTrainingPlan(root, { ...options, agent });
      expect(plan.targets[0].datasets.train.examples[0].overrides).toEqual([{ section: "memory", id: "self", declaredBy: agent }]);
    }
  });

  it("rejects a declared network if a consumer has no resolved attachment", async () => {
    const root = await trainingProject(teamFiles());
    await writeTrainingFile(root, "b/Spawnfile", agentManifest({ name: "b", training: undefined }));
    await writeTrainingFile(root, "training/train.yaml", { examples: [{ ...example, networks: [network] }] });
    await expect(createTrainingPlan(root, options)).rejects.toThrow(/agent:b networks: unknown id news/u);
  });

  it("recognizes ambiguity retained in merged network attachment contexts", async () => {
    const root = await trainingProject({
      Spawnfile: teamManifest({ shared: undefined, networks: undefined, memory: undefined,
        members: [{ id: "red", ref: "red" }, { id: "blue", ref: "blue" }] }),
      ...Object.fromEntries(["red", "blue"].map((name) => [`${name}/Spawnfile`, teamManifest({ name,
        shared: undefined, memory: undefined, networks: [{ ...network, rooms: [{ id: "assignment", members: ["writer"] }] }],
        members: [{ id: "writer", ref: "../writer" }]
      })])),
      ...Object.fromEntries(Object.entries(dataFiles).map(([name, value]) => [`writer/${name}`, value])),
      "writer/Spawnfile": agentManifest({ surfaces })
    });
    await writeTrainingFile(root, "writer/training/train.yaml", { examples: [{ ...example, networks: [network] }] });
    await expect(createTrainingPlan(root, { ...options, agent: "agent:writer" })).rejects.toThrow(/networks: ambiguous id news/u);
  });

  it("resolves a synthesized representative's parent network from compiler attachments", async () => {
    const root = await trainingProject({ ...dataFiles,
      Spawnfile: teamManifest({ shared: undefined, memory: undefined,
        networks: [{ ...network, rooms: [{ id: "assignment", members: ["child"] }] }],
        members: [{ id: "child", ref: "child" }] }),
      "child/Spawnfile": teamManifest({ name: "child", shared: undefined, networks: undefined, memory: undefined,
        members: [{ id: "writer", ref: "writer" }] }),
      ...Object.fromEntries(Object.entries(dataFiles).map(([name, value]) => [`child/writer/${name}`, value])),
      "child/writer/Spawnfile": agentManifest()
    });
    await writeTrainingFile(root, "child/writer/training/train.yaml", { examples: [{ ...example, networks: [network] }] });
    const plan = await createTrainingPlan(root, { ...options, agent: "agent:writer" });
    expect(plan.targets[0].datasets.train.examples[0].overrides).toEqual([{ section: "networks", id: "news", declaredBy: "team:publication" }]);
  });

  it("guards resource ambiguity on the resolved resource collection", async () => {
    const project = await loadTrainingProject(await trainingProject(teamFiles()));
    const agent = trainingAgents(project).find((entry) => entry.id === "agent:a")!;
    agent.value.workspaceResources!.push({ ...agent.value.workspaceResources![0], scope: { kind: "agent", key: agent.value.source, name: "a" } });
    expect(() => resolveTrainingResource(project.compilePlan, agent, "edition-state", "record.volumes"))
      .toThrow(/ambiguous id edition-state/u);
  });

  it("resolves record volumes and preserves explicit empty recording", async () => {
    const root = await trainingProject(teamFiles());
    await writeTrainingFile(root, "a/Spawnfile", agentManifest({ name: "a", training: { record: { keep: "30d", volumes: ["edition-state"] } } }));
    expect((await createTrainingPlan(root, options)).record).toEqual({ keep: "30d", volumes: [{ id: "edition-state", declaredBy: "team:publication" }] });
    await writeTrainingFile(root, "a/Spawnfile", agentManifest({ name: "a", training: { record: {} } }));
    expect((await createTrainingPlan(root, options)).record).toEqual({ keep: null, volumes: [] });
  });

  it.each(["unknown", "git", "fed"])("rejects %s record volumes", async (kind) => {
    const resource = kind === "git" ? { id: "edition-state", kind: "git", url: "https://example.invalid/repo", mount: "./state", mode: "readonly" }
      : { ...volume, ...(kind === "fed" ? { name: "fed", feed: { directory: "../data" } } : {}) };
    const root = await trainingProject({ ...dataFiles, Spawnfile: agentManifest({
      workspace: { docs: { system: "AGENTS.md" }, resources: [resource] },
      training: { ...training, record: { volumes: [kind === "unknown" ? "missing" : "edition-state"] } }
    }) });
    await expect(createTrainingPlan(root, { ...options, agent: "agent:writer" })).rejects
      .toThrow(kind === "unknown" ? /unknown id missing/u : kind === "git" ? /must be a volume/u : /fed volume.*landing log/u);
  });

  it("does not use another agent's resources for a locally owned target", async () => {
    const root = await trainingProject({ ...dataFiles, Spawnfile: agentManifest() });
    await writeTrainingFile(root, "training/train.yaml", { examples: [{ ...example, resources: [volume] }] });
    await expect(createTrainingPlan(root, { ...options, agent: "agent:writer" })).rejects.toThrow(/resources: unknown id edition-state/u);
  });
});
