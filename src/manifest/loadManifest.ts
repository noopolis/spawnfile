import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { fileExists, isSymlink, readUtf8File, resolveProjectPath } from "../filesystem/index.js";
import { SpawnfileError } from "../shared/index.js";
import {
  AgentManifest,
  ExecutionBlock,
  Manifest,
  McpServer,
  RuntimeBinding,
  SharedSurface,
  SkillReference,
  TeamManifest,
  isAgentManifest,
  isTeamManifest,
  manifestSchema
} from "./schemas.js";
import { parseSkillFrontmatter } from "./skillFrontmatter.js";

export interface LoadedManifest<TManifest extends Manifest = Manifest> {
  manifest: TManifest;
  manifestPath: string;
}

const ensureUniqueNames = (names: string[], label: string): void => {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      throw new SpawnfileError("validation_error", `Duplicate ${label}: ${name}`);
    }
    seen.add(name);
  }
};

const getMcpNames = (mcpServers?: McpServer[]): Set<string> =>
  new Set((mcpServers ?? []).map((server) => server.name));

const validateSkillRequirements = (
  skills: SkillReference[] | undefined,
  visibleMcpNames: Set<string>
): void => {
  for (const skill of skills ?? []) {
    for (const mcpName of skill.requires?.mcp ?? []) {
      if (!visibleMcpNames.has(mcpName)) {
        throw new SpawnfileError(
          "validation_error",
          `Skill ${skill.ref} requires undeclared MCP server: ${mcpName}`
        );
      }
    }
  }
};

const validateDocFiles = async (manifestPath: string, manifest: Manifest): Promise<void> => {
  const docs = manifest.docs;
  if (!docs) {
    return;
  }

  const docPaths = [
    docs.heartbeat,
    docs.identity,
    docs.memory,
    docs.soul,
    docs.system,
    ...Object.values(docs.extras ?? {})
  ].filter((value): value is string => Boolean(value));

  await Promise.all(
    docPaths.map(async (documentPath) => {
      const resolvedPath = resolveProjectPath(manifestPath, documentPath);
      if (await isSymlink(resolvedPath)) {
        throw new SpawnfileError(
          "validation_error",
          `Symlinks are not allowed: ${documentPath}`
        );
      }
      if (!(await fileExists(resolvedPath))) {
        throw new SpawnfileError(
          "validation_error",
          `Document not found for manifest ${manifestPath}: ${documentPath}`
        );
      }
    })
  );
};

const validateSkills = async (
  manifestPath: string,
  skills: SkillReference[] | undefined
): Promise<void> => {
  await Promise.all(
    (skills ?? []).map(async (skill) => {
      const skillDirPath = resolveProjectPath(manifestPath, skill.ref);
      if (await isSymlink(skillDirPath)) {
        throw new SpawnfileError(
          "validation_error",
          `Symlinks are not allowed: ${skill.ref}`
        );
      }
      const skillFilePath = resolveProjectPath(manifestPath, `${skill.ref}/SKILL.md`);
      if (!(await fileExists(skillFilePath))) {
        throw new SpawnfileError(
          "validation_error",
          `Skill directory missing SKILL.md: ${skill.ref}`
        );
      }

      parseSkillFrontmatter(await readUtf8File(skillFilePath));
    })
  );
};

const validateLocalAgentManifest = async (
  manifestPath: string,
  manifest: AgentManifest
): Promise<void> => {
  ensureUniqueNames((manifest.mcp_servers ?? []).map((server) => server.name), "MCP server");
  ensureUniqueNames((manifest.subagents ?? []).map((subagent) => subagent.id), "subagent id");

  await validateDocFiles(manifestPath, manifest);
  await validateSkills(manifestPath, manifest.skills);
  validateSkillRequirements(manifest.skills, getMcpNames(manifest.mcp_servers));
};

const getSharedMcpNames = (shared: SharedSurface | undefined): Set<string> =>
  getMcpNames(shared?.mcp_servers);

const validateLocalTeamManifest = async (
  manifestPath: string,
  manifest: TeamManifest
): Promise<void> => {
  ensureUniqueNames((manifest.shared?.mcp_servers ?? []).map((server) => server.name), "MCP server");
  ensureUniqueNames(manifest.members.map((member) => member.id), "member id");

  await validateDocFiles(manifestPath, manifest);
  await validateSkills(manifestPath, manifest.shared?.skills);
  validateSkillRequirements(manifest.shared?.skills, getSharedMcpNames(manifest.shared));

  const memberIds = new Set(manifest.members.map((member) => member.id));

  if (manifest.structure.leader && !memberIds.has(manifest.structure.leader)) {
    throw new SpawnfileError(
      "validation_error",
      `Structure leader is not a declared team member: ${manifest.structure.leader}`
    );
  }

  for (const id of manifest.structure.external ?? []) {
    if (!memberIds.has(id)) {
      throw new SpawnfileError(
        "validation_error",
        `Structure external references undeclared member: ${id}`
      );
    }
  }
};

const parseManifest = (source: string): Manifest => {
  try {
    return manifestSchema.parse(parseYaml(source));
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issue = error.issues[0];
      throw new SpawnfileError(
        "invalid_manifest",
        `Invalid Spawnfile manifest: ${issue.message}`
      );
    }

    throw error;
  }
};

export const loadManifest = async (manifestPath: string): Promise<LoadedManifest> => {
  const source = await readUtf8File(manifestPath);
  const manifest = parseManifest(source);

  if (isAgentManifest(manifest)) {
    await validateLocalAgentManifest(manifestPath, manifest);
  }

  if (isTeamManifest(manifest)) {
    await validateLocalTeamManifest(manifestPath, manifest);
  }

  return { manifest, manifestPath };
};

export interface NormalizedRuntimeBinding {
  name: string;
  options: Record<string, unknown>;
}

export const normalizeRuntimeBinding = (
  runtime: RuntimeBinding | undefined
): NormalizedRuntimeBinding | undefined => {
  if (!runtime) {
    return undefined;
  }

  if (typeof runtime === "string") {
    return { name: runtime, options: {} };
  }

  return {
    name: runtime.name,
    options: runtime.options ?? {}
  };
};

export const mergeExecution = (
  parentExecution: ExecutionBlock | undefined,
  childExecution: ExecutionBlock | undefined
): ExecutionBlock | undefined => {
  if (!parentExecution) {
    return childExecution;
  }

  if (!childExecution) {
    return parentExecution;
  }

  const model =
    parentExecution.model || childExecution.model
      ? {
          fallback: childExecution.model?.fallback ?? parentExecution.model?.fallback,
          primary: childExecution.model?.primary ?? parentExecution.model?.primary
        }
      : undefined;

  if (model && !model.primary) {
    throw new SpawnfileError(
      "validation_error",
      "Merged execution model is missing a primary model"
    );
  }

  const sandbox =
    parentExecution.sandbox || childExecution.sandbox
      ? {
          ...parentExecution.sandbox,
          ...childExecution.sandbox
        }
      : undefined;

  if (sandbox && !sandbox.mode) {
    throw new SpawnfileError(
      "validation_error",
      "Merged execution sandbox is missing mode"
    );
  }

  const workspace =
    parentExecution.workspace || childExecution.workspace
      ? {
          ...parentExecution.workspace,
          ...childExecution.workspace
        }
      : undefined;

  if (workspace && !workspace.isolation) {
    throw new SpawnfileError(
      "validation_error",
      "Merged execution workspace is missing isolation"
    );
  }

  const resolvedModel: NonNullable<ExecutionBlock["model"]> | undefined = model
    ? {
        fallback: model.fallback,
        primary: model.primary!
      }
    : undefined;

  const resolvedSandbox: NonNullable<ExecutionBlock["sandbox"]> | undefined = sandbox
    ? {
        mode: sandbox.mode!
      }
    : undefined;

  const resolvedWorkspace: NonNullable<ExecutionBlock["workspace"]> | undefined = workspace
    ? {
        isolation: workspace.isolation!
      }
    : undefined;

  return {
    ...parentExecution,
    ...childExecution,
    model: resolvedModel,
    sandbox: resolvedSandbox,
    workspace: resolvedWorkspace
  };
};
