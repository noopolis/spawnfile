import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { SpawnfileError } from "../../shared/index.js";
import { getManifestPath } from "../../filesystem/index.js";
import { buildCompilePlan } from "../buildCompilePlan.js";
import { stableStringify } from "../helpers.js";
import { resolveEffectiveModelTarget } from "../modelEnv.js";
import type { CompilePlanNode, ResolvedAgentNode } from "../types.js";
import { TRAINING_CONTEXT_VERSION, trainingContextSchema, type TrainingContext, type TrainingSource } from "./contract.js";

const sha256 = (value: string | Buffer): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const invalid = (message: string): never => { throw new SpawnfileError("validation_error", message); };
const inside = (root: string, file: string): boolean => {
  const relative = path.relative(root, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export interface CreateTrainingContextOptions {
  agent?: string;
  packageVersion: string;
}

/** Resolves the complete project, preserving inherited selection and source provenance. */
export const createTrainingContext = async (
  inputPath: string,
  options: CreateTrainingContextOptions
): Promise<TrainingContext> => {
  const plan = await buildCompilePlan(await realpath(getManifestPath(inputPath)));
  const agents = plan.nodes.filter((node): node is CompilePlanNode & { value: ResolvedAgentNode } => node.kind === "agent");
  const selected = options.agent === undefined
    ? agents.length === 1 ? agents[0] : undefined
    : agents.find((node) => node.id === options.agent);
  if (!selected) invalid(options.agent === undefined
    ? "Training requires --agent with an exact node id when the project does not contain exactly one agent"
    : `No canonical agent matches ${options.agent}`);
  const agent = selected!.value;
  const manifest = await realpath(plan.root);
  const root = path.dirname(manifest);
  const pins = new Map<string, TrainingSource>();

  const pin = async (source: string, expectedContent?: string): Promise<TrainingSource> => {
    const sourcePath = path.resolve(source);
    if (!inside(root, sourcePath) || !inside(root, await realpath(sourcePath))) {
      invalid("Training context v1 requires source files inside the canonical project root");
    }
    const info = await stat(sourcePath);
    if (!info.isFile() || info.size > 16 * 1024 * 1024) invalid("Training source must be a regular file no larger than 16 MiB");
    const bytes = await readFile(sourcePath);
    if (expectedContent !== undefined && bytes.toString("utf8") !== expectedContent) {
      invalid("Training source changed during canonical graph resolution");
    }
    const next = { sourcePath, destinationPath: path.relative(root, sourcePath).split(path.sep).join("/"), sha256: sha256(bytes) };
    const previous = pins.get(sourcePath);
    if (previous && previous.sha256 !== next.sha256) invalid("Training source changed while its context was captured");
    pins.set(sourcePath, next);
    return next;
  };

  await pin(manifest);
  // Manifests for inline nodes live at sourcePath; their synthetic node source is not a file.
  for (const node of plan.nodes) {
    await pin(node.value.kind === "agent" ? node.value.sourcePath ?? node.value.source : node.value.source);
    for (const document of node.value.docs) await pin(document.sourcePath, document.content);
    const skills = node.value.kind === "agent" ? node.value.skills : node.value.shared.skills;
    for (const skill of skills) await pin(skill.sourcePath, skill.content);
  }
  const documents = await Promise.all(agent.docs.map(async (document) => ({
    ...await pin(document.sourcePath, document.content), role: document.role
  })));
  const skills = await Promise.all(agent.skills.map(async (skill) => ({
    ...await pin(skill.sourcePath, skill.content), name: skill.name, ref: skill.ref, requiresMcp: skill.requiresMcp
  })));
  // A manifest can change after graph resolution but before its first pin. Re-resolve
  // through the compiler owner, then seal all captured bytes against that graph.
  if (stableStringify(plan) !== stableStringify(await buildCompilePlan(manifest))) {
    invalid("Training source changed between canonical resolution and provenance capture");
  }
  for (const source of [...pins.keys()]) await pin(source);
  const sources = [...pins.values()].sort((left, right) => left.destinationPath < right.destinationPath ? -1 : left.destinationPath > right.destinationPath ? 1 : 0);
  const declaredPrimary = agent.execution?.model?.primary;
  const primary = declaredPrimary ? resolveEffectiveModelTarget(declaredPrimary, agent.execution) : undefined;
  return trainingContextSchema.parse({
    version: TRAINING_CONTEXT_VERSION,
    producer: { package: "spawnfile", version: options.packageVersion },
    project: { root, manifest, sourceDigest: sha256(JSON.stringify(sources.map(({ destinationPath, sha256: hash }) => ({ destinationPath, sha256: hash })))) },
    agent: {
      id: selected!.id, name: agent.name, source: path.resolve(agent.sourcePath ?? agent.source), runtime: agent.runtime.name,
      engine: typeof agent.runtime.options.engine === "string" ? agent.runtime.options.engine : null,
      model: primary ? { provider: primary.provider, name: primary.name, authMethod: primary.auth.method } : null
    },
    sources, documents, skills,
    resources: (agent.workspaceResources ?? []).map((resource) => ({
      id: resource.id, kind: resource.kind, mount: resource.mount, mode: resource.mode, sharing: resource.sharing,
      definitionDigest: sha256(stableStringify(resource)),
      pin: resource.kind === "bundle" ? resource.sha256 : resource.kind === "git" ? resource.ref ?? null : null
    })),
    requirements: { nativeCompilation: true, isolatedPreparation: true }
  });
};
