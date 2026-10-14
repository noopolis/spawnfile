import { mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTrainingContext } from "../context.js";
import { trainingProject, cleanTrainingProjects, agentManifest } from "../plan/fixtures.test-helper.js";
import { compileTrainingCandidate, type TrainingCandidateResource } from "./candidate.js";
import { compileProject } from "../../compileProject.js";
import { snapshotTrainingSource } from "./snapshot.js";

afterEach(cleanTrainingProjects);
const fixture = async () => {
  const root = await trainingProject({});
  const project = path.join(root, "project");
  await mkdir(project);
  await writeFile(path.join(project, "Spawnfile"), JSON.stringify(agentManifest({ training: undefined })));
  await writeFile(path.join(project, "AGENTS.md"), "Write precisely.\n");
  const context = await createTrainingContext(project, { packageVersion: "test" });
  const resource: TrainingCandidateResource = { sourcePath: "AGENTS.md", sourceContent: "Write precisely.\n", content: "Cite verified facts.\n", edit: "editable" };
  return { root, project, context, resource, out: path.join(root, "trial") };
};

it("compiles candidate overlay through the real compiler without editing canonical source", async () => {
  const f = await fixture();
  await symlink("AGENTS.md", path.join(f.project, "CLAUDE.md"));
  const result = await compileTrainingCandidate({ ...f, resources: [f.resource], editablePaths: ["AGENTS.md"] });
  expect(await readFile(path.join(f.project, "AGENTS.md"), "utf8")).toBe(f.resource.sourceContent);
  expect(await readFile(path.join(result.projectRoot, "AGENTS.md"), "utf8"), "candidate overlay guarantee").toBe(f.resource.content);
  expect(await realpath(path.join(result.projectRoot, "CLAUDE.md"))).toBe(path.join(result.projectRoot, "AGENTS.md"));
  const rendered = await readFile(path.join(result.agent.outputDirectory, "workspace/AGENTS.md"), "utf8");
  expect(rendered, "candidate compilation guarantee").toContain(f.resource.content.trim());
  expect(JSON.parse(await readFile(result.native!.configPath, "utf8")).agents[0].instructions).toContain(f.resource.content.trim());
  expect(JSON.parse(await readFile(path.join(f.out, "compilation.json"), "utf8"))).toEqual(result);
});

it("refuses changed locked and undeclared overlays before compilation", async () => {
  const f = await fixture(), compile = vi.fn();
  for (const resource of [{ ...f.resource, edit: "locked" as const }, { ...f.resource, sourcePath: "Spawnfile" },
    { ...f.resource, sourceContent: "different baseline" }]) {
    await expect(compileTrainingCandidate({ ...f, resources: [resource] }, { compile }), "locked overlay guarantee").rejects.toThrow(/locked|pinned/u);
  }
  await expect(compileTrainingCandidate({ ...f, resources: [f.resource], editablePaths: [] }, { compile })).rejects.toThrow("unauthored");
  await expect(compileTrainingCandidate({ ...f, resources: [f.resource, f.resource] }, { compile })).rejects.toThrow("unique");
  await expect(compileTrainingCandidate({ ...f, resources: [] }, { compile })).rejects.toThrow("requires");
  expect(compile).not.toHaveBeenCalled();
});

it("refuses source drift and source/scratch aliases", async () => {
  const f = await fixture(), compile = vi.fn();
  await expect(compileTrainingCandidate({ ...f, resources: [f.resource], out: path.join(f.project, "trial") }, { compile })).rejects.toThrow("disjoint");
  await expect(compileTrainingCandidate({ ...f, resources: [f.resource], context: { ...f.context,
    project: { ...f.context.project, sourceDigest: `sha256:${"0".repeat(64)}` } } }, { compile })).rejects.toThrow("inventory");
  await writeFile(path.join(f.project, "AGENTS.md"), "drift");
  await expect(compileTrainingCandidate({ ...f, resources: [f.resource] }, { compile }), "source pin guarantee").rejects.toThrow("pinned bytes");
  expect(compile).not.toHaveBeenCalled();
});

it("refuses credential and escaping link paths instead of copying them into candidates", async () => {
  const f = await fixture();
  await mkdir(path.join(f.project, ".grok"));
  await expect(compileTrainingCandidate({ ...f, resources: [f.resource] }), "credential isolation guarantee").rejects.toThrow("credential");
  await rm(f.out, { recursive: true, force: true });
  await rm(path.join(f.project, ".grok"), { recursive: true });
  await symlink("../", path.join(f.project, "escape"));
  await expect(compileTrainingCandidate({ ...f, resources: [f.resource] })).rejects.toThrow("symlink escapes");
});

it("requires actual selected native outputs and honours cancellation", async () => {
  const f = await fixture();
  await expect(compileTrainingCandidate({ ...f, resources: [f.resource], signal: AbortSignal.abort() })).rejects.toThrow();
  await expect(compileTrainingCandidate({ ...f, resources: [f.resource] }, { compile: vi.fn(async () => ({
    outputDirectory: f.out, report: { nodes: [] }
  }) as never) })).rejects.toThrow("canonical selected agent");
});

it("checks the actual compiler receipt, config and output confinement before admitting a native run", async () => {
  for (const failure of ["node", "runtime", "error", "output", "instance", "config", "config-path"]) {
    const f = await fixture();
    const compile: typeof compileProject = async (input, options) => {
      const result = await compileProject(input, options);
      if (failure === "node") result.report.nodes = [];
      if (failure === "runtime") result.report.nodes[0]!.runtime = "other";
      if (failure === "error") result.report.nodes[0]!.diagnostics.push({ level: "error", message: "refused" });
      if (failure === "output") result.report.nodes[0]!.output_dir = "../outside";
      const instance = result.report.container!.runtime_instances[0]!;
      if (failure === "instance") result.report.container!.runtime_instances = [];
      if (failure === "config") await writeFile(path.join(result.outputDirectory, "container/rootfs", instance.config_path), '{"agents":[]}');
      if (failure === "config-path") instance.config_path = "../../../../outside.json";
      return result;
    };
    await expect(compileTrainingCandidate({ ...f, resources: [f.resource] }, { compile })).rejects.toThrow(/canonical|escapes|unique/u);
  }
});

it("preserves unchanged locked resources and refuses changed snapshot bytes or symlink overlays", async () => {
  const f = await fixture();
  const unchanged = { ...f.resource, content: f.resource.sourceContent, edit: "locked" as const };
  expect((await compileTrainingCandidate({ ...f, resources: [unchanged], editablePaths: [] })).resources).toHaveLength(1);
  for (const mutation of ["bytes", "link"]) {
    const next = await fixture();
    const snapshot: typeof snapshotTrainingSource = async (...args) => {
      await snapshotTrainingSource(...args);
      const file = path.join(args[1], "AGENTS.md");
      if (mutation === "bytes") await writeFile(file, "tampered");
      else { await rm(file); await symlink(path.join(next.project, "AGENTS.md"), file); }
    };
    await expect(compileTrainingCandidate({ ...next, resources: [next.resource] }, { snapshot })).rejects.toThrow(/snapshot|canonical/u);
  }
});
