import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";

import { getManifestPath, resolveProjectPath } from "../../../filesystem/index.js";
import {
  isInlineAgentMember, isReferencedMember, trainingDatasetSchema,
  type TrainingDeclaration
} from "../../../manifest/index.js";
import { parseManifest } from "../../../manifest/parseManifest.js";
import { buildCompilePlan } from "../../buildCompilePlan.js";
import { invalidTraining } from "./references.js";
import { resolveTrainingPlan } from "./resolve.js";
import type { TrainingPlan } from "./contract.js";
import type { LoadedTrainingProject, LoadedTrainingTarget, TrainingFileSource, TrainingTargetFile } from "./types.js";

const source = (root: string, sourcePath: string): TrainingFileSource => ({
  sourcePath, path: path.relative(root, sourcePath).split(path.sep).join("/")
});
const reason = (error: unknown): string => error instanceof Error ? error.message : String(error);
const inside = (root: string, file: string): boolean => {
  const relative = path.relative(root, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/** Training-only preflight preserves target diagnostics before the compiler reads docs/skills. */
const validateTrainingTargetSources = async (manifestPath: string, visited = new Set<string>()): Promise<void> => {
  const realManifest = await realpath(manifestPath).catch((error: unknown) =>
    invalidTraining(`Unable to load training manifest ${manifestPath}: ${reason(error)}`));
  if (visited.has(realManifest)) return;
  visited.add(realManifest);
  const manifest = parseManifest(await readFile(manifestPath, "utf8"), manifestPath);
  const declarations: Array<{ declaredBy: string; training?: TrainingDeclaration }> = manifest.kind === "agent"
    ? [{ declaredBy: `agent:${manifest.name}`, training: manifest.training }]
    : [
        { declaredBy: `team:${manifest.name}`, training: manifest.shared?.training },
        ...manifest.members.filter(isInlineAgentMember).map((member) => ({
          declaredBy: `agent:${member.id}`, training: member.training
        }))
      ];
  for (const { declaredBy, training } of declarations) {
    for (const target of training?.targets ?? []) {
      for (const file of target.files) {
        const sourcePath = resolveProjectPath(manifestPath, file);
        const context = `Training target ${sourcePath} declared by ${declaredBy} (${manifestPath})`;
        const stats = await lstat(sourcePath).catch((error: unknown) =>
          invalidTraining(`${context} must be an existing regular .md file: ${reason(error)}`));
        if (stats.isSymbolicLink()) invalidTraining(`${context} must not be a symlink`);
        if (!stats.isFile()) invalidTraining(`${context} must be an existing regular .md file`);
      }
    }
  }
  const refs = manifest.kind === "team"
    ? manifest.members.filter(isReferencedMember).map((member) => member.ref)
    : (manifest.subagents ?? []).map((subagent) => subagent.ref);
  for (const ref of refs) {
    await validateTrainingTargetSources(getManifestPath(resolveProjectPath(manifestPath, ref)), visited);
  }
};

const readYaml = async <T>(file: string, schema: z.ZodType<T>, declaredBy: string): Promise<T> => {
  try {
    return schema.parse(parseYaml(await readFile(file, "utf8"), { strict: true, uniqueKeys: true }));
  } catch (error) {
    return invalidTraining(`Invalid training file ${file} declared by ${declaredBy}: ${reason(error)}`);
  }
};

const loadDataFileSource = async (root: string, file: string, declaredBy: string): Promise<TrainingFileSource> => {
  const context = `Invalid training file ${file} declared by ${declaredBy}:`;
  if (!inside(root, file)) invalidTraining(`${context} must be inside project root ${root}`);
  const realPath = await realpath(file).catch((error: unknown) =>
    invalidTraining(`${context} must be an existing regular file: ${reason(error)}`));
  if (!inside(root, realPath)) invalidTraining(`${context} must be inside project root ${root} (no symlink escape)`);
  const stats = await stat(file).catch((error: unknown) =>
    invalidTraining(`${context} must be an existing regular file: ${reason(error)}`));
  if (!stats.isFile()) invalidTraining(`${context} must be an existing regular file`);
  return source(root, file);
};

/** Inspect every ancestor, including unreferenced Spawnfiles outside the compiled graph. */
const nestedManifests = async (directory: string, file: string): Promise<string[]> => {
  if (!inside(directory, file)) return [];
  const manifests: string[] = [];
  for (let ancestor = path.dirname(file); ancestor !== directory; ancestor = path.dirname(ancestor)) {
    const manifest = path.join(ancestor, "Spawnfile");
    try {
      if ((await stat(manifest)).isFile()) manifests.push(manifest);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        invalidTraining(`Unable to inspect nested Spawnfile ${manifest} for training target ${file}: ${reason(error)}`);
      }
    }
  }
  return manifests;
};

const loadTargetFile = async (
  root: string, directory: string, realDirectory: string, file: string
): Promise<TrainingTargetFile> => {
  const result: TrainingTargetFile = { ...source(root, file), realPath: null, regular: false, nestedManifests: [] };
  try {
    result.realPath = await realpath(file);
    result.regular = (await stat(file)).isFile();
  } catch (error) {
    result.error = reason(error);
    return result;
  }
  result.nestedManifests = [...new Set([
    ...await nestedManifests(directory, file),
    ...await nestedManifests(realDirectory, result.realPath)
  ])].sort();
  return result;
};

/** Local reads only. Loading preserves complete declarations; resolution projects public identities. */
export const loadTrainingProject = async (inputPath: string): Promise<LoadedTrainingProject> => {
  let manifest: string;
  try { manifest = await realpath(getManifestPath(inputPath)); }
  catch (error) { return invalidTraining(`Unable to load training project ${inputPath}: ${reason(error)}`); }
  await validateTrainingTargetSources(manifest);
  const compilePlan = await buildCompilePlan(manifest);
  const root = path.dirname(compilePlan.root);
  const project: LoadedTrainingProject = { root, manifest, compilePlan, targets: [], datasets: {}, graders: {} };
  for (const node of compilePlan.nodes) {
    const training = node.value.training;
    if (!training) continue;
    const manifestPath = node.value.kind === "agent" ? node.value.sourcePath ?? node.value.source : node.value.source;
    const directory = path.dirname(manifestPath);
    const realDirectory = await realpath(directory);
    for (const grader of Object.values(training.graders)) {
      if (project.graders[grader.sourcePath]) continue;
      project.graders[grader.sourcePath] = await loadDataFileSource(root, grader.sourcePath, grader.declaredBy);
    }
    for (const declaration of training.targets) {
      const target: LoadedTrainingTarget = {
        declaredBy: node.id, kind: node.kind, directory, realDirectory, declaration,
        files: await Promise.all(declaration.files.map((file) => loadTargetFile(root, directory, realDirectory, file)))
      };
      project.targets.push(target);
      for (const file of Object.values(declaration.datasets)) {
        if (!file || project.datasets[file]) continue;
        project.datasets[file] = {
          ...await loadDataFileSource(root, file, node.id), value: await readYaml(file, trainingDatasetSchema, node.id)
        };
      }
    }
  }
  return project;
};

export interface CreateTrainingPlanOptions {
  agent?: string;
  packageVersion: string;
}

export const createTrainingPlan = async (inputPath: string, options: CreateTrainingPlanOptions): Promise<TrainingPlan> =>
  resolveTrainingPlan(await loadTrainingProject(inputPath), options.agent, options.packageVersion);
