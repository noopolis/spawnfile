import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { compileProject, type CompileProjectOptions } from "../../compileProject.js";
import { trainingContextSchema, type TrainingContext } from "../contract.js";
import { sealFile, within } from "../preparation/files.js";
import { snapshotTrainingSource } from "./snapshot.js";

const sha = (bytes: string | Buffer): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
export interface TrainingCandidateResource {
  sourcePath: string; sourceContent: string; content: string; edit: "editable" | "locked";
}
export interface CompileTrainingCandidateOptions {
  context: TrainingContext; resources: readonly TrainingCandidateResource[]; out: string;
  signal?: AbortSignal; sourceRoot?: string; compileOptions?: CompileProjectOptions;
  /** When supplied, only the authored target files can change. */
  editablePaths?: readonly string[];
}
export interface TrainingCandidateCompilation {
  projectRoot: string; compiledRoot: string; reportPath: string;
  agent: { id: string; outputDirectory: string };
  resources: { sourcePath: string; sha256: string }[];
  native?: { configPath: string; configSha256: string };
}

/** Compile overlays through the real canonical compiler before any native trial is admitted. */
export const compileTrainingCandidate = async (options: CompileTrainingCandidateOptions,
  dependencies: { compile?: typeof compileProject; snapshot?: typeof snapshotTrainingSource } = {}): Promise<TrainingCandidateCompilation> => {
  const context = trainingContextSchema.parse(options.context);
  options.signal?.throwIfAborted();
  const sourceRoot = path.resolve(options.sourceRoot ?? context.project.root), out = path.resolve(options.out);
  if (await realpath(context.project.root) !== context.project.root || !within(sourceRoot, context.project.root) ||
    within(sourceRoot, out) || within(out, sourceRoot)) throw Error("Candidate scratch must be disjoint from its canonical source");
  const pins = context.sources.map(({ destinationPath, sha256 }) => ({ destinationPath, sha256 }));
  if (sha(JSON.stringify(pins)) !== context.project.sourceDigest) throw Error("Candidate canonical source inventory differs from its context");
  for (const source of context.sources) {
    if (source.sourcePath !== path.join(context.project.root, source.destinationPath) ||
      !within(sourceRoot, await realpath(source.sourcePath)) || (await sealFile(await realpath(source.sourcePath), "pin")).sha256 !== source.sha256) {
      throw Error("Candidate canonical source differs from its pinned bytes");
    }
  }
  const allowed = new Map([...context.documents, ...context.skills].map(row => [row.destinationPath, row]));
  const observed = new Set<string>();
  for (const resource of options.resources) {
    const pin = allowed.get(resource.sourcePath);
    if (!pin || observed.has(resource.sourcePath) || sha(resource.sourceContent) !== pin.sha256) throw Error("Candidate resource is not a unique pinned native document");
    if (resource.edit !== "editable" && resource.edit !== "locked" ||
      (resource.edit === "locked" || options.editablePaths && !options.editablePaths.includes(resource.sourcePath)) && resource.content !== resource.sourceContent) {
      throw Error("Candidate changed a locked or unauthored resource");
    }
    observed.add(resource.sourcePath);
  }
  if (!options.resources.length) throw Error("Candidate compilation requires native resources");
  await mkdir(out, { mode: 0o700 });
  if (await realpath(out) !== out) throw Error("Candidate scratch must be canonical");
  const snapshot = path.join(out, "source");
  await (dependencies.snapshot ?? snapshotTrainingSource)(sourceRoot, snapshot, options.signal);
  const projectRoot = path.join(snapshot, path.relative(sourceRoot, context.project.root));
  for (const source of context.sources) {
    const file = path.join(projectRoot, source.destinationPath);
    if ((await sealFile(await realpath(file), "pin")).sha256 !== source.sha256) throw Error("Candidate snapshot differs from canonical source");
  }
  const resources = [];
  for (const resource of options.resources) {
    const file = path.join(projectRoot, resource.sourcePath);
    if (await realpath(file) !== file || !(await lstat(file)).isFile()) throw Error("Candidate overlay requires a canonical regular destination");
    await writeFile(file, resource.content, { mode: 0o600 });
    resources.push({ sourcePath: resource.sourcePath, sha256: sha(resource.content) });
  }
  options.signal?.throwIfAborted();
  const compiledRoot = path.join(out, "compiled");
  const result = await (dependencies.compile ?? compileProject)(path.join(projectRoot, path.relative(context.project.root, context.project.manifest)),
    { ...options.compileOptions, bundleCacheDirectory: options.compileOptions?.bundleCacheDirectory ?? path.join(out, "bundle-cache"),
      outputDirectory: compiledRoot, clean: false });
  options.signal?.throwIfAborted();
  const agent = result.report.nodes.find(node => node.id === context.agent.id);
  if (result.outputDirectory !== compiledRoot || !agent?.output_dir || agent.runtime !== context.agent.runtime ||
    result.report.nodes.some(node => node.diagnostics.some(row => row.level === "error"))) throw Error("Candidate compilation did not produce the canonical selected agent");
  const outputDirectory = path.resolve(compiledRoot, agent.output_dir);
  if (!within(compiledRoot, outputDirectory) || await realpath(outputDirectory) !== outputDirectory) throw Error("Compiled agent output escapes candidate scratch");
  const instances = result.report.container?.runtime_instances.filter(row => row.runtime === "daimon" && row.node_ids?.includes(context.agent.id)) ?? [];
  let native: TrainingCandidateCompilation["native"];
  if (context.agent.runtime === "daimon") {
    if (instances.length !== 1) throw Error("Candidate compiler produced no unique native runtime instance");
    const configPath = path.join(compiledRoot, "container/rootfs", instances[0]!.config_path);
    if (!within(compiledRoot, configPath) || await realpath(configPath) !== configPath) throw Error("Native config escapes compiled scratch");
    const bytes = await readFile(configPath);
    const config = JSON.parse(bytes.toString("utf8")) as { agents?: { id: string }[] };
    if (config.agents?.filter(row => row.id === context.agent.id).length !== 1) throw Error("Native config does not contain the selected canonical agent");
    native = { configPath, configSha256: sha(bytes) };
  }
  const receipt = { projectRoot, compiledRoot, reportPath: result.reportPath, agent: { id: context.agent.id, outputDirectory }, resources,
    ...(native ? { native } : {}) };
  await writeFile(path.join(out, "compilation.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return receipt;
};
