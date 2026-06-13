import path from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { fileExists, isSymlink, readUtf8File, resolveProjectPath } from "../filesystem/index.js";
import { SpawnfileError } from "../shared/index.js";
import {
  AgentManifest,
  ExecutionBlock,
  Manifest,
  McpServer,
  SharedSurface,
  RuntimeBinding,
  TeamWorkspace,
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

const MARKDOWN_EXTENSION_PATTERN = /\.(md|markdown)$/i;

const assertMarkdownDocumentPath = (documentPath: string): void => {
  if (!MARKDOWN_EXTENSION_PATTERN.test(documentPath)) {
    throw new SpawnfileError(
      "validation_error",
      `Document paths must point to Markdown files: ${documentPath}`
    );
  }
};

const validateDocFiles = async (
  manifestPath: string,
  docs: TeamWorkspace["docs"] | undefined
): Promise<void> => {
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
      assertMarkdownDocumentPath(documentPath);
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

const validateManifestRefs = async (
  manifestPath: string,
  refs: string[] | undefined,
  label: string
): Promise<void> => {
  await Promise.all(
    (refs ?? []).map(async (ref) => {
      const refDirectoryPath = resolveProjectPath(manifestPath, ref);
      if (await isSymlink(refDirectoryPath)) {
        throw new SpawnfileError(
          "validation_error",
          `Symlinks are not allowed: ${ref}`
        );
      }

      const childManifestPath = path.join(refDirectoryPath, "Spawnfile");
      if (await isSymlink(childManifestPath)) {
        throw new SpawnfileError(
          "validation_error",
          `Symlinks are not allowed: ${ref}/Spawnfile`
        );
      }
      if (!(await fileExists(childManifestPath))) {
        throw new SpawnfileError(
          "validation_error",
          `${label} ref must point to a directory containing a Spawnfile: ${ref}`
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
      if (await isSymlink(skillFilePath)) {
        throw new SpawnfileError(
          "validation_error",
          `Symlinks are not allowed: ${skill.ref}/SKILL.md`
        );
      }
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
  const agentWorkspaceSkills = manifest.workspace?.skills;
  const agentEnvironment = manifest.environment;

  ensureUniqueNames((agentEnvironment?.mcp_servers ?? []).map((server) => server.name), "MCP server");
  ensureUniqueNames((manifest.subagents ?? []).map((subagent) => subagent.id), "subagent id");

  await validateDocFiles(manifestPath, manifest.workspace?.docs);
  await validateSkills(manifestPath, agentWorkspaceSkills);
  await validateManifestRefs(
    manifestPath,
    manifest.subagents?.map((subagent) => subagent.ref),
    "Subagent"
  );
  validateSkillRequirements(agentWorkspaceSkills, getMcpNames(agentEnvironment?.mcp_servers));
};

const getSharedMcpNames = (shared: SharedSurface | undefined): Set<string> =>
  getMcpNames(shared?.environment?.mcp_servers);

const validateLocalTeamManifest = async (
  manifestPath: string,
  manifest: TeamManifest
): Promise<void> => {
  const sharedWorkspace = manifest.shared?.workspace;
  const sharedEnvironment = manifest.shared?.environment;

  ensureUniqueNames(
    (sharedEnvironment?.mcp_servers ?? []).map((server) => server.name),
    "MCP server"
  );
  ensureUniqueNames(manifest.members.map((member) => member.id), "member id");

  await validateDocFiles(manifestPath, sharedWorkspace?.docs);
  await validateSkills(manifestPath, sharedWorkspace?.skills);
  await validateManifestRefs(
    manifestPath,
    manifest.members.map((member) => member.ref),
    "Member"
  );
  validateSkillRequirements(sharedWorkspace?.skills, getSharedMcpNames(manifest.shared));

  const memberIds = new Set(manifest.members.map((member) => member.id));

  if (manifest.lead && !memberIds.has(manifest.lead)) {
    throw new SpawnfileError(
      "validation_error",
      `Lead is not a declared team member: ${manifest.lead}`
    );
  }

  for (const id of manifest.external ?? []) {
    if (!memberIds.has(id)) {
      throw new SpawnfileError(
        "validation_error",
        `External references undeclared member: ${id}`
      );
    }
  }
};

const parseManifest = (source: string): Manifest => {
  let parsed: unknown;
  try {
    parsed = parseYaml(source);
  } catch (error) {
    // A YAML syntax error is a malformed manifest, not a runtime failure — wrap
    // it so it exits as a usage error instead of leaking the parser's wording.
    const reason = error instanceof Error ? error.message : String(error);
    throw new SpawnfileError("invalid_manifest", `Invalid Spawnfile manifest: ${reason}`);
  }

  try {
    return manifestSchema.parse(parsed);
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
  let source: string;
  try {
    source = await readUtf8File(manifestPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // A missing Spawnfile is a usage/input error, not a runtime failure.
      throw new SpawnfileError(
        "validation_error",
        `No Spawnfile found at ${manifestPath}. Pass a project directory or Spawnfile path, or run 'spawnfile init'.`
      );
    }
    throw error;
  }
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
          auth: childExecution.model?.auth ?? parentExecution.model?.auth,
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

  const resolvedModel: NonNullable<ExecutionBlock["model"]> | undefined = model
    ? {
        auth: model.auth,
        fallback: model.fallback,
        primary: model.primary!
      }
    : undefined;

  const resolvedSandbox: NonNullable<ExecutionBlock["sandbox"]> | undefined = sandbox
    ? {
        mode: sandbox.mode!
      }
    : undefined;

  return {
    ...parentExecution,
    ...childExecution,
    model: resolvedModel,
    sandbox: resolvedSandbox
  };
};
