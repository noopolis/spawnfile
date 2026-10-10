import { TRAINING_PLAN_VERSION, trainingPlanSchema, type TrainingPlan } from "./contract.js";
import { invalidTraining, lexical, resolveTrainingResource } from "./references.js";
import { planGrader, resolveTrainingTarget, trainingAgents } from "./targets.js";
import type { LoadedTrainingProject, TrainingAgentNode } from "./types.js";

const optimizerFor = (agent: TrainingAgentNode, hasTargets: boolean): TrainingPlan["optimizer"] => {
  const optimizer = agent.value.training?.optimizer;
  const required = ["method", "model", "variants", "keep"] as const;
  const missing: string[] = required.filter((key) => optimizer?.[key] === undefined);
  if (optimizer?.budget?.rounds === undefined) missing.push("budget.rounds");
  if (missing.length > 0) {
    if (hasTargets) invalidTraining(`Training optimizer for ${agent.id} is missing fields: ${missing.join(", ")}`);
    return null;
  }
  if (hasTargets && optimizer!.keep! > optimizer!.variants!) {
    invalidTraining(`Training optimizer for ${agent.id} requires keep <= variants`);
  }
  return {
    method: optimizer!.method!, model: optimizer!.model!, variants: optimizer!.variants!, keep: optimizer!.keep!,
    budget: { rounds: optimizer!.budget!.rounds! }
  };
};

const recordFor = (project: LoadedTrainingProject, agent: TrainingAgentNode): TrainingPlan["record"] => {
  const record = agent.value.training?.record;
  if (record === undefined) return null;
  return {
    keep: record.keep ?? null,
    volumes: (record.volumes ?? []).map((id) => {
      const context = `Training record.volumes for ${agent.id}`;
      const { resource, declaredBy } = resolveTrainingResource(project.compilePlan, agent, id, context);
      if (resource.kind !== "volume") invalidTraining(`${context}: ${id} must be a volume`);
      if (resource.kind === "volume" && resource.feed) {
        invalidTraining(`${context}: fed volume ${id} is recorded through its landing log`);
      }
      return { id, declaredBy };
    }).sort((left, right) => lexical(left.id, right.id))
  };
};

/** JSON key ordering is part of the deterministic public representation. */
const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => lexical(left, right)).map(([key, item]) => [key, sortKeys(item)])
  );
  return value;
};

/** Pure projection over loaded facts: no filesystem, clock, execution, or mutation. */
export const resolveTrainingPlan = (
  project: LoadedTrainingProject, agentId: string | undefined, producerVersion: string
): TrainingPlan => {
  const agents = trainingAgents(project);
  const selected = agentId === undefined
    ? agents.length === 1 ? agents[0] : undefined
    : agents.find((agent) => agent.id === agentId);
  if (!selected) return invalidTraining(agentId === undefined
    ? "Training requires --agent with an exact node id when the project does not contain exactly one agent"
    : `No canonical agent matches ${agentId}`);

  const graders = Object.entries(selected.value.training?.graders ?? {})
    .map(([name, grader]) => planGrader(project, name, grader));
  const targets: TrainingPlan["targets"] = [];
  for (const target of project.targets) {
    const resolved = resolveTrainingTarget(project, target, selected.id);
    if (!resolved) continue;
    targets.push(resolved.target);
    graders.push(resolved.grader);
  }
  const uniqueGraders = [...new Map(graders.map((grader) => [JSON.stringify(sortKeys(grader)), grader])).values()];
  uniqueGraders.sort((left, right) => lexical(`${left.name}:${left.declaredBy}:${left.path}`, `${right.name}:${right.declaredBy}:${right.path}`));
  targets.sort((left, right) => lexical(JSON.stringify(sortKeys(left)), JSON.stringify(sortKeys(right))));
  const plan = trainingPlanSchema.parse({
    version: TRAINING_PLAN_VERSION,
    producer: { package: "spawnfile", version: producerVersion },
    project: { root: project.root, manifest: project.manifest },
    agent: { id: selected.id, name: selected.value.name },
    record: recordFor(project, selected), optimizer: optimizerFor(selected, targets.length > 0),
    graders: uniqueGraders, targets
  });
  return sortKeys(plan) as TrainingPlan;
};
