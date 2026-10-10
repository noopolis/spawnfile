import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";

import { getManifestPath } from "../../../filesystem/index.js";
import { trainingDatasetSchema, trainingGraderSchema } from "../../../manifest/index.js";
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

const readYaml = async <T>(file: string, schema: z.ZodType<T>, declaredBy: string): Promise<T> => {
  try {
    return schema.parse(parseYaml(await readFile(file, "utf8"), { strict: true, uniqueKeys: true }));
  } catch (error) {
    return invalidTraining(`Invalid training file ${file} declared by ${declaredBy}: ${reason(error)}`);
  }
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
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
    result.nestedManifests = [...new Set([
      ...await nestedManifests(directory, file),
      ...await nestedManifests(realDirectory, result.realPath)
    ])].sort();
  } catch (error) {
    result.error = reason(error);
  }
  return result;
};

/** Local reads only. Loading preserves complete declarations; resolution projects public identities. */
export const loadTrainingProject = async (inputPath: string): Promise<LoadedTrainingProject> => {
  let manifest: string;
  try { manifest = await realpath(getManifestPath(inputPath)); }
  catch (error) { return invalidTraining(`Unable to load training project ${inputPath}: ${reason(error)}`); }
  const compilePlan = await buildCompilePlan(manifest);
  const root = path.dirname(manifest);
  const project: LoadedTrainingProject = { root, manifest, compilePlan, targets: [], datasets: {}, graders: {} };
  for (const node of compilePlan.nodes) {
    const training = node.value.training;
    if (!training) continue;
    const manifestPath = node.value.kind === "agent" ? node.value.sourcePath ?? node.value.source : node.value.source;
    const directory = path.dirname(manifestPath);
    const realDirectory = await realpath(directory);
    for (const grader of Object.values(training.graders)) {
      if (project.graders[grader.sourcePath]) continue;
      const value = await readYaml(grader.sourcePath, trainingGraderSchema, grader.declaredBy);
      project.graders[grader.sourcePath] = {
        ...source(root, grader.sourcePath),
        value: { ...value, ...(value.labels ? { labels: value.labels.map((label) => ({
          ...label, output: path.resolve(path.dirname(grader.sourcePath), label.output)
        })) } : {}) }
      };
    }
    for (const declaration of training.targets) {
      const target: LoadedTrainingTarget = {
        declaredBy: node.id, kind: node.kind, directory, realDirectory, declaration,
        files: await Promise.all(declaration.files.map((file) => loadTargetFile(root, directory, realDirectory, file)))
      };
      project.targets.push(target);
      for (const file of Object.values(declaration.datasets)) {
        if (!file || project.datasets[file]) continue;
        project.datasets[file] = { ...source(root, file), value: await readYaml(file, trainingDatasetSchema, node.id) };
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
