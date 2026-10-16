import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";
import { afterEach, expect, it } from "vitest";
import { createTrainingContext } from "./context.js";
import { mapTrainingExecution } from "./execution.js";
import { prepareTrainingContainer } from "./container/prepare.js";
import { activationFixture } from "./session/activation.test-helper.js";
import { activateTrainingExecution } from "./session/activation.js";
import { cleanTrainingProjects } from "./plan/fixtures.test-helper.js";
import { loadTrainingProject } from "./plan/index.js";
import { writeRecordedVolumeSnapshot } from "./rewind/snapshotFixtures.test-helper.js";

afterEach(cleanTrainingProjects);
const resources = [
  { id: "state", kind: "volume", mount: "./state", mode: "mutable" },
  { id: "cache", kind: "volume", mount: "./cache", mode: "mutable" },
];

it("activates host-to-container mapped receipts with workspace resources without weakening canonical identity", async () => {
  const f = await activationFixture({ workspace: { docs: { system: "AGENTS.md" }, resources } });
  const project = await loadTrainingProject(f.projectRoot);
  const agentSlug = project.compilePlan.nodes.find(node => node.id === f.context.agent.id)!.slug;
  for (const resource of resources) await writeRecordedVolumeSnapshot(path.join(f.projectRoot, "history"), {
    agentSlug, agentId: f.context.agent.id, rootId: resource.id, snapshot: "20261006T000000000Z-fixture",
    startedAt: "2026-10-06T00:00:00Z", files: { "state.txt": "Historical state.\n" },
  });
  const prepared = await prepareTrainingContainer({ version: "spawnfile.training-container.v1", slots: 2, dockerContext: "local",
    inputs: [{ source: f.projectRoot, destination: "/run/training/inputs/project" }],
    output: { source: f.execution.output, destination: "/run/training/output" }, auth: [] }, f.context, f.execution.args);
  expect(prepared.context.resources).toEqual(f.context.resources);
  // Reproduce the mounted tree under writable test scratch; production addresses remain /run/training.
  const container = path.join(f.root, "container");
  const local = (file: string) => file.replace(/^\/run\/training/u, container);
  await cp(f.projectRoot, local(prepared.context.project.root), { recursive: true });
  await mkdir(local("/run/training/output"), { recursive: true });
  const context = JSON.parse(JSON.stringify(prepared.context).replaceAll("/run/training", container));
  const projectMap = (file: string) => local(file.startsWith(f.projectRoot)
    ? file.replace(f.projectRoot, "/run/training/inputs/project") : file.replace(f.execution.output, "/run/training/output"));
  const execution = mapTrainingExecution(f.execution, projectMap);
  const canonical = await createTrainingContext(context.project.root, { packageVersion: "test" });
  expect(context.resources, "relocated resource identity guarantee").toEqual(canonical.resources);
  const activated = await activateTrainingExecution({ execution, context, prepareCase: f.prepareCase });
  expect(activated.datasets.train).toContain(container);
  const changed = structuredClone(context); changed.resources[0]!.definitionDigest = `sha256:${"0".repeat(64)}`;
  await expect(activateTrainingExecution({ execution, context: changed, prepareCase: f.prepareCase })).rejects.toThrow("context differs");
});

it("keeps generated bundle training pins stable across relocation and sensitive to declared inputs", async () => {
  const f = await activationFixture();
  const manifest = parse(await readFile(path.join(f.projectRoot, "Spawnfile"), "utf8"));
  manifest.workspace = { docs: { system: "AGENTS.md" }, resources: [{
    id: "generated", kind: "bundle", mount: "./generated", mode: "readonly",
    build: { generated: { cwd: ".", inputs: [{ root: ".", exclude: ["history", "training"] }],
      command: ["node", "build.mjs", "${output}"] } },
  }] };
  await writeFile(path.join(f.projectRoot, "Spawnfile"), stringify(manifest));
  const git = (...args: string[]) => execFileSync("git", ["-C", f.projectRoot, ...args], { encoding: "utf8" });
  git("init", "--quiet"); git("add", ".");
  // Object-only fixture identity: do not commit or move either repository's HEAD.
  const tree = git("write-tree").trim();
  const revision = execFileSync("git", ["-C", f.projectRoot, "commit-tree", tree, "-m", "fixture"], {
    encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" },
  }).trim();
  git("update-ref", "HEAD", revision);
  const original = await createTrainingContext(f.projectRoot, { packageVersion: "test" });
  const relocated = path.join(f.root, "relocated"); await cp(f.projectRoot, relocated, { recursive: true });
  const moved = await createTrainingContext(relocated, { packageVersion: "test" });
  expect(moved.resources, "relocated generated pin guarantee").toEqual(original.resources);
  await writeFile(path.join(relocated, "AGENTS.md"), "Changed input.\n");
  expect((await createTrainingContext(relocated, { packageVersion: "test" })).resources[0]!.pin).not.toBe(original.resources[0]!.pin);
});
