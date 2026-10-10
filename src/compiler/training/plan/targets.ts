import path from "node:path";

import type { TrainingPlan, TrainingPlanDataset } from "./contract.js";
import { invalidTraining, lexical, resolveTrainingOverride } from "./references.js";
import type { LoadedTrainingProject, LoadedTrainingTarget, TrainingAgentNode, TrainingTargetFile } from "./types.js";

const inside = (root: string, file: string): boolean => {
  const relative = path.relative(root, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export const trainingAgents = (project: LoadedTrainingProject): TrainingAgentNode[] =>
  project.compilePlan.nodes.filter((node): node is TrainingAgentNode => node.value.kind === "agent");

const targetFile = (
  file: TrainingTargetFile, target: LoadedTrainingTarget, agents: TrainingAgentNode[]
): TrainingPlan["targets"][number]["files"][number] => {
  const context = `Training target ${file.sourcePath} declared by ${target.declaredBy}`;
  if (file.error) invalidTraining(`${context}: ${file.error}`);
  if (!file.realPath || !inside(target.directory, file.sourcePath) || !inside(target.realDirectory, file.realPath)) {
    invalidTraining(`${context} must be inside its declaring manifest directory (no symlink escape)`);
  }
  if (!file.regular || !file.sourcePath.endsWith(".md")) invalidTraining(`${context} must be an existing regular .md file`);
  if (file.nestedManifests.length > 0) invalidTraining(`${context} belongs to a nested Spawnfile: ${file.nestedManifests.join(", ")}`);
  const consumers = agents.filter((agent) => [...agent.value.docs, ...agent.value.skills]
    .some((entry) => entry.sourcePath === file.sourcePath)).map((agent) => agent.id).sort(lexical);
  if (consumers.length === 0) invalidTraining(`${context} is not consumed by any agent document or skill`);
  return { sourcePath: file.sourcePath, path: file.path, consumers };
};

export const planGrader = (
  project: LoadedTrainingProject, name: string, reference: { sourcePath: string; declaredBy: string }
): TrainingPlan["graders"][number] => {
  const grader = project.graders[reference.sourcePath]
    ?? invalidTraining(`Training grader ${name} declared by ${reference.declaredBy} was not loaded: ${reference.sourcePath}`);
  return {
    name, declaredBy: reference.declaredBy, sourcePath: grader.sourcePath, path: grader.path,
    questions: grader.value.questions.length, labels: grader.value.labels?.length ?? 0
  };
};

const datasetFor = (
  project: LoadedTrainingProject, target: LoadedTrainingTarget, agent: TrainingAgentNode, sourcePath: string
): TrainingPlanDataset => {
  const dataset = project.datasets[sourcePath]
    ?? invalidTraining(`Training dataset ${sourcePath} declared by ${target.declaredBy} was not loaded`);
  return {
    sourcePath: dataset.sourcePath, path: dataset.path,
    examples: dataset.value.examples.map((example) => ({
      id: example.id, at: example.at, wake: { ...example.wake },
      overrides: (["resources", "memory", "networks"] as const).flatMap((section) =>
        (example[section] ?? []).map((entry) => resolveTrainingOverride(
          project.compilePlan, agent, section, entry.id,
          `Training dataset ${sourcePath} example ${example.id} declared by ${target.declaredBy} for ${agent.id} ${section}`
        ))).sort((left, right) => lexical(`${left.section}:${left.id}:${left.declaredBy}`, `${right.section}:${right.id}:${right.declaredBy}`))
    })).sort((left, right) => lexical(left.id, right.id))
  };
};

export const resolveTrainingTarget = (
  project: LoadedTrainingProject, target: LoadedTrainingTarget, selectedId: string
): { target: TrainingPlan["targets"][number]; grader: TrainingPlan["graders"][number] } | null => {
  const agents = trainingAgents(project);
  const files = target.files.map((file) => targetFile(file, target, agents)).sort((left, right) => lexical(left.path, right.path));
  const declaringNode = project.compilePlan.nodes.find((node) => node.id === target.declaredBy)
    ?? invalidTraining(`Unknown training declaring node ${target.declaredBy}`);
  const registry = declaringNode.value.training?.graders ?? {};
  const reference = (Object.hasOwn(registry, target.declaration.grader) ? registry[target.declaration.grader] : undefined)
    ?? invalidTraining(`Training target declared by ${target.declaredBy} references unknown grader ${target.declaration.grader}`);
  const grader = planGrader(project, target.declaration.grader, reference);
  const consumerIds = new Set(files.flatMap((file) => file.consumers));
  const checkedAgents = target.kind === "team"
    ? agents.filter((agent) => consumerIds.has(agent.id))
    : agents.filter((agent) => agent.id === target.declaredBy);
  const { train, validation, test } = target.declaration.datasets;
  let selectedDatasets: TrainingPlan["targets"][number]["datasets"] | undefined;
  // Resolve every consumer even when the caller selects a different one.
  for (const agent of checkedAgents) {
    const datasets = {
      train: datasetFor(project, target, agent, train),
      validation: validation === undefined ? null : datasetFor(project, target, agent, validation),
      test: datasetFor(project, target, agent, test)
    };
    if (agent.id === selectedId) selectedDatasets = datasets;
  }
  return selectedDatasets ? {
    target: { declaredBy: target.declaredBy, grader: target.declaration.grader, files, datasets: selectedDatasets }, grader
  } : null;
};
