import { SpawnfileError } from "../../../shared/index.js";
import type { CompilePlan, ResolvedAgentNode } from "../../types.js";
import type { ResolvedWorkspaceResource } from "../../workspaceResources.js";
import type { TrainingPlanOverride } from "./contract.js";
import type { TrainingAgentNode } from "./types.js";

export const invalidTraining = (message: string): never => {
  throw new SpawnfileError("validation_error", message);
};

export const lexical = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const declaredId = (plan: CompilePlan, source: string): string =>
  plan.nodes.find((node) => node.value.source === source)?.id
    ?? invalidTraining(`Training reference has no declaring node: ${source}`);

const one = <T>(matches: T[], id: string, context: string): T => {
  if (matches.length === 0) invalidTraining(`${context}: unknown id ${id}`);
  if (matches.length > 1) invalidTraining(`${context}: ambiguous id ${id}`);
  return matches[0]!;
};

/** Shared selection for the authoring plan and runtime recording; resolved visibility is authoritative. */
export const resolveTrainingRecordVolumes = (
  agent: { id: string; value: ResolvedAgentNode }
): Array<ResolvedWorkspaceResource & { kind: "volume" }> =>
  (agent.value.training?.record?.volumes ?? []).map((id) => {
    const context = `Training record.volumes for ${agent.id}`;
    const resource = one((agent.value.workspaceResources ?? []).filter((entry) => entry.id === id), id, context);
    if (resource.kind !== "volume") return invalidTraining(`${context}: ${id} must be a volume`);
    if (resource.feed) return invalidTraining(`${context}: fed volume ${id} is recorded through its landing log`);
    return resource;
  }).sort((left, right) => lexical(left.id, right.id));

export const resolveTrainingResource = (
  plan: CompilePlan, agent: TrainingAgentNode, id: string, context: string
): { resource: ResolvedWorkspaceResource; declaredBy: string } => {
  const resource = one((agent.value.workspaceResources ?? []).filter((entry) => entry.id === id), id, context);
  return { resource, declaredBy: declaredId(plan, resource.scope.key) };
};

/** Uses compiler-resolved visibility, including shared banks and representative attachments. */
export const resolveTrainingOverride = (
  plan: CompilePlan, agent: TrainingAgentNode,
  section: TrainingPlanOverride["section"], id: string, context: string
): TrainingPlanOverride => {
  let declaredBy: string;
  if (section === "resources") {
    declaredBy = resolveTrainingResource(plan, agent, id, context).declaredBy;
  } else if (section === "memory") {
    // Multiple member slots can expose the same bank. They are one item, not ambiguity.
    const sources = [...new Set((agent.value.memoryAccess ?? [])
      .filter((entry) => entry.bank.id === id).map((entry) => entry.source))];
    declaredBy = declaredId(plan, one(sources, id, context));
  } else {
    const attachedSources = new Set<string>();
    for (const attachment of agent.value.surfaces?.moltnet ?? []) {
      if (attachment.network !== id) continue;
      if (attachment.teamSource) attachedSources.add(attachment.teamSource);
      for (const source of Object.keys(attachment.contextRooms ?? {})) attachedSources.add(source);
    }
    const matches = plan.nodes.filter((node) => node.value.kind === "team"
      && attachedSources.has(node.value.source)
      && node.value.networks?.some((network) => network.id === id));
    declaredBy = one(matches, id, context).id;
  }
  return { section, id, declaredBy };
};
