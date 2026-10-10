import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";

// Test-only fixture I/O; excluded from the emitted package by tsconfig.build.json.
const roots: string[] = [];
export const cleanTrainingProjects = async (): Promise<void> => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
};
export const writeTrainingFile = async (root: string, name: string, value: unknown): Promise<void> => {
  const file = path.join(root, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof value === "string" ? value : stringify(value));
};
export const trainingProject = async (files: Record<string, unknown>): Promise<string> => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-training-plan-")));
  roots.push(root);
  for (const [name, value] of Object.entries(files)) await writeTrainingFile(root, name, value);
  return root;
};

export const optimizer = { method: "gepa", model: "claude-opus-5-5", variants: 8, keep: 3, budget: { rounds: 10 } };
export const target = {
  files: ["AGENTS.md"], grader: "writing",
  datasets: { train: "training/train.yaml", test: "training/test.yaml" }
};
export const training = { optimizer, graders: { writing: "training/writing.grader.yaml" }, targets: [target] };
export const example = {
  id: "ice-shooting", at: "2026-10-09T10:20:31+02:00",
  wake: { surface: "moltnet", room: "assignment", from: "brass", text: "@writer report" }
};
export const dataFiles = {
  "AGENTS.md": "Write precisely.\n",
  "training/train.yaml": { examples: [example] },
  "training/test.yaml": { examples: [{ ...example, id: "held-out" }] },
  "training/writing.grader.yaml": "\u0000Opaque calibrated decision model\n"
};
export const agentManifest = (extra: Record<string, unknown> = {}) => ({
  spawnfile_version: "0.1", kind: "agent", name: "writer", runtime: "daimon",
  workspace: { docs: { system: "AGENTS.md" } }, training, ...extra
});
export const volume = { id: "edition-state", kind: "volume", mode: "mutable", mount: "./edition-state" };
export const memory = { id: "self", store: { kind: "memory" } };
export const network = {
  id: "news", provider: "moltnet",
  rooms: [{ id: "assignment", members: ["a", "b"] }],
  server: { mode: "managed", listen: { bind: "127.0.0.1", port: 18881 }, store: { kind: "memory" }, auth: { mode: "open" } }
};
export const surfaces = { moltnet: [{ network: "news", rooms: { assignment: { wake: "mentions" } } }] };
export const teamManifest = (extra: Record<string, unknown> = {}) => ({
  spawnfile_version: "0.1", kind: "team", name: "publication", mode: "swarm",
  shared: {
    workspace: { docs: { soul: "SOUL.md" }, resources: [volume] },
    training: { ...training, targets: [{ ...target, files: ["SOUL.md"] }] }
  },
  memory: [{ ...memory, id: "team-memory" }], networks: [network],
  members: [{ id: "a", ref: "a" }, { id: "b", ref: "b" }], ...extra
});
export const teamFiles = () => ({
  ...dataFiles, "SOUL.md": "Shared purpose.\n", Spawnfile: teamManifest(),
  "a/Spawnfile": agentManifest({ name: "a", training: undefined, surfaces, memory: [memory] }),
  "a/AGENTS.md": "Agent A.\n",
  "b/Spawnfile": agentManifest({ name: "b", training: undefined, surfaces, memory: [memory] }),
  "b/AGENTS.md": "Agent B.\n"
});
