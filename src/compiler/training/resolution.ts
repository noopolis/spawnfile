import path from "node:path";

import type { TrainingDeclaration, TrainingTarget } from "../../manifest/index.js";
import { SpawnfileError } from "../../shared/index.js";
import type { CompilePlanNode } from "../types.js";

export interface ResolvedTrainingGrader {
  sourcePath: string;
  /** A source key during traversal; a stable node ID in the finished compile plan. */
  declaredBy: string;
}

export interface ResolvedTraining {
  deadlines?: TrainingDeclaration["deadlines"];
  preparation?: { hook: string; history?: string };
  record?: TrainingDeclaration["record"];
  optimizer?: TrainingDeclaration["optimizer"];
  judges?: NonNullable<TrainingDeclaration["judges"]>;
  /** Guide documents as absolute paths. */
  critic?: NonNullable<TrainingDeclaration["critic"]>;
  graders: Record<string, ResolvedTrainingGrader>;
  /** Only this node's targets, with absolute file and dataset paths. */
  targets: TrainingTarget[];
}

/** Resolve declaration-relative paths before any inheritance or shadowing. */
export const resolveTrainingDeclaration = (
  declaration: TrainingDeclaration | undefined,
  manifestPath: string,
  declaredBy: string
): ResolvedTraining | undefined => {
  if (declaration === undefined) return undefined;
  const resolve = (value: string): string => path.resolve(path.dirname(manifestPath), value);
  return {
    ...(declaration.deadlines === undefined ? {} : { deadlines: { ...declaration.deadlines } }),
    ...(declaration.preparation === undefined ? {} : { preparation: { ...declaration.preparation,
      ...(declaration.preparation.history === undefined ? {} : { history: resolve(declaration.preparation.history) }) } }),
    ...(declaration.record === undefined ? {} : { record: { ...declaration.record,
      ...(declaration.record.volumes === undefined ? {} : { volumes: [...declaration.record.volumes] }) } }),
    ...(declaration.optimizer === undefined ? {} : { optimizer: { ...declaration.optimizer,
      ...(declaration.optimizer.budget === undefined ? {} : { budget: { ...declaration.optimizer.budget } }) } }),
    ...(declaration.judges === undefined ? {} : { judges: structuredClone(declaration.judges) }),
    ...(declaration.critic === undefined ? {} : { critic: { ...declaration.critic, guide: declaration.critic.guide.map(resolve),
      ...(declaration.critic.show === undefined ? {} : { show: [...declaration.critic.show] }) } }),
    graders: Object.fromEntries(Object.entries(declaration.graders ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => [name, { sourcePath: resolve(value), declaredBy }])),
    targets: (declaration.targets ?? []).map((target) => ({
      files: target.files.map(resolve),
      grader: target.grader,
      datasets: {
        train: resolve(target.datasets.train),
        ...(target.datasets.validation === undefined ? {} : { validation: resolve(target.datasets.validation) }),
        test: resolve(target.datasets.test)
      }
    }))
  };
};

/** Direct team membership only: field merges, local arrays, local targets. */
export const mergeTrainingDeclarations = (
  inherited: ResolvedTraining | undefined,
  local: ResolvedTraining | undefined
): ResolvedTraining | undefined => {
  const deadlines = inherited?.deadlines === undefined && local?.deadlines === undefined
    ? undefined : { ...inherited?.deadlines, ...local?.deadlines };
  const record = inherited?.record === undefined && local?.record === undefined
    ? undefined : { ...inherited?.record, ...local?.record };
  const budget = inherited?.optimizer?.budget === undefined && local?.optimizer?.budget === undefined
    ? undefined : { ...inherited?.optimizer?.budget, ...local?.optimizer?.budget };
  const optimizer = inherited?.optimizer === undefined && local?.optimizer === undefined
    ? undefined : { ...inherited?.optimizer, ...local?.optimizer, ...(budget === undefined ? {} : { budget }) };
  const graders = { ...inherited?.graders, ...local?.graders };
  const judges = { ...inherited?.judges, ...local?.judges };
  const critic = local?.critic ?? inherited?.critic;
  const targets = local?.targets ?? [];
  const preparation = local?.preparation ?? inherited?.preparation;
  if (deadlines === undefined && preparation === undefined && record === undefined && optimizer === undefined && critic === undefined && Object.keys(judges).length === 0 && Object.keys(graders).length === 0 && targets.length === 0) {
    return undefined;
  }
  return {
    ...(deadlines === undefined ? {} : { deadlines }),
    ...(preparation === undefined ? {} : { preparation }),
    ...(record === undefined ? {} : { record }),
    ...(optimizer === undefined ? {} : { optimizer }),
    ...(Object.keys(judges).length === 0 ? {} : { judges: Object.fromEntries(Object.entries(judges).sort(([left], [right]) => left.localeCompare(right))) }),
    ...(critic === undefined ? {} : { critic }),
    graders: Object.fromEntries(Object.entries(graders).sort(([left], [right]) => left.localeCompare(right))),
    targets
  };
};

/** Provenance uses the same stable IDs as every finished graph consumer. */
export const resolvePlanTrainingSources = (nodes: CompilePlanNode[]): void => {
  const idBySource = new Map(nodes.map((node) => [node.value.source, node.id]));
  for (const node of nodes) {
    if (!node.value.training) continue;
    node.value.training.graders = Object.fromEntries(Object.entries(node.value.training.graders).map(([name, grader]) => {
      const declaredBy = idBySource.get(grader.declaredBy);
      if (declaredBy === undefined) {
        throw new SpawnfileError("compile_error", `Training grader ${name} has unknown declaring source ${grader.declaredBy}`);
      }
      return [name, { ...grader, declaredBy }];
    }));
  }
};
