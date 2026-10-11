import path from "node:path";
import type { LoadedTrainingProject, TrainingPlan, TrainingAgentNode } from "../plan/index.js";
import { resolveTrainingOverride, resolveTrainingResource } from "../plan/references.js";
import { selectTrainingExample } from "./select.js";
import { normalizeInstant } from "./instant.js";
import type { RewindInput } from "./types.js";

/** The same compiled resources, accessible bank sources and surface attachments P2 resolves. */
export const resolveRewindInputs = (
  plan: TrainingPlan, project: LoadedTrainingProject, selector: string
) => {
  const selected = selectTrainingExample(plan, selector);
  const agent = project.compilePlan.nodes.find((node): node is TrainingAgentNode =>
    node.value.kind === "agent" && node.id === plan.agent.id);
  if (!agent) throw new Error(`No compiled training agent ${plan.agent.id}`);
  const raw = project.datasets[selected.sourcePath]?.value.examples.find((example) => example.id === selected.id);
  if (!raw || normalizeInstant(raw.at) !== normalizeInstant(selected.example.at)) throw new Error(`Loaded example disagrees with plan: ${selector}`);
  const inputs: RewindInput[] = [];
  const declarationBase = (id: string): string => {
    const node = project.compilePlan.nodes.find((candidate) => candidate.id === id);
    if (!node) throw new Error(`Missing declaring node ${id}`);
    return path.dirname(node.value.kind === "agent" ? node.value.sourcePath ?? node.value.source : node.value.source);
  };
  for (const resource of agent.value.workspaceResources ?? []) {
    const { declaredBy } = resolveTrainingResource(project.compilePlan, agent, resource.id, "Rewind resource");
    inputs.push({ section: "resources", id: resource.id, declaredBy, declarationBase: declarationBase(declaredBy),
      declaration: resource, overridden: false });
  }
  const banks = new Set<string>();
  for (const entry of agent.value.memoryAccess ?? []) {
    const key = JSON.stringify([entry.source, entry.bank.id]);
    if (banks.has(key)) continue;
    banks.add(key);
    const node = project.compilePlan.nodes.find((candidate) => candidate.value.source === entry.source);
    if (!node) throw new Error(`Memory bank ${entry.bank.id} has no declaring node`);
    inputs.push({ section: "memory", id: entry.bank.id, declaredBy: node.id,
      declarationBase: declarationBase(node.id), declaration: entry.bank, overridden: false });
  }
  const networks = new Set<string>();
  for (const attachment of agent.value.surfaces?.moltnet ?? []) {
    const sources = new Set([attachment.teamSource, ...Object.keys(attachment.contextRooms ?? {})]);
    for (const node of project.compilePlan.nodes) {
      if (node.value.kind !== "team" || !sources.has(node.value.source)) continue;
      for (const network of node.value.networks ?? []) {
        if (network.id !== attachment.network) continue;
        const key = JSON.stringify([node.id, network.id]);
        if (networks.has(key)) continue;
        networks.add(key);
        inputs.push({ section: "networks", id: network.id, declaredBy: node.id,
          declarationBase: declarationBase(node.id), declaration: network, overridden: false });
      }
    }
  }
  for (const section of ["resources", "memory", "networks"] as const) {
    for (const declaration of raw[section] ?? []) {
      const identity = resolveTrainingOverride(project.compilePlan, agent, section, declaration.id, `Rewind override ${selector}`);
      const index = inputs.findIndex((input) => input.section === section && input.id === identity.id && input.declaredBy === identity.declaredBy);
      if (index === -1) throw new Error(`Missing effective override ${section}:${identity.id}`);
      inputs[index] = { ...inputs[index], declaration, declarationBase: path.dirname(selected.sourcePath), overridden: true } as RewindInput;
    }
  }
  inputs.sort((a, b) => a.section.localeCompare(b.section) || a.declaredBy.localeCompare(b.declaredBy) || a.id.localeCompare(b.id));
  return { inputs, selected, at: normalizeInstant(raw.at), agentSlug: agent.slug };
};
