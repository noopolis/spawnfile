import path from "node:path";

import { SpawnfileError } from "../shared/index.js";

import { stableStringify } from "./helpers.js";
import type {
  ResolvedAgentNode,
  ResolvedDocument,
  ResolvedPackage,
  ResolvedSkill
} from "./types.js";
import { mergeWorkspaceResources } from "./workspaceResources.js";

const assertSame = (
  field: string,
  existing: unknown,
  next: unknown,
  nodeName: string
): void => {
  if (stableStringify(existing) === stableStringify(next)) {
    return;
  }

  throw new SpawnfileError(
    "compile_error",
    `Agent ${nodeName} resolves with incompatible ${field} across team imports`
  );
};

const mergeEnvStrict = (
  existing: Record<string, string>,
  next: Record<string, string>,
  nodeName: string
): Record<string, string> => {
  const merged = { ...existing };

  for (const [key, value] of Object.entries(next)) {
    if (merged[key] !== undefined && merged[key] !== value) {
      throw new SpawnfileError(
        "validation_error",
        `Agent ${nodeName} receives conflicting environment variable ${key} across team imports`
      );
    }
    merged[key] = value;
  }

  return merged;
};

const mergeByKeyStrict = <T>(
  existing: T[] | undefined,
  next: T[] | undefined,
  getKey: (value: T) => string,
  label: string,
  nodeName: string
): T[] | undefined => {
  const merged = new Map<string, T>();

  for (const value of existing ?? []) {
    merged.set(getKey(value), value);
  }

  for (const value of next ?? []) {
    const key = getKey(value);
    const previous = merged.get(key);
    if (previous && stableStringify(previous) !== stableStringify(value)) {
      throw new SpawnfileError(
        "validation_error",
        `Agent ${nodeName} receives conflicting ${label} ${key} across team imports`
      );
    }
    merged.set(key, value);
  }

  return merged.size > 0 ? [...merged.values()] : undefined;
};

const mergeDocuments = (
  existing: ResolvedDocument[],
  next: ResolvedDocument[],
  agentSourcePath: string
): ResolvedDocument[] => {
  const agentDirectory = path.dirname(agentSourcePath);
  const isAgentLocalDoc = (doc: ResolvedDocument): boolean => {
    const sourcePath = path.resolve(doc.sourcePath);
    return sourcePath === agentDirectory || sourcePath.startsWith(`${agentDirectory}${path.sep}`);
  };
  const merged = new Map(
    existing.filter(isAgentLocalDoc).map((doc) => [doc.role, doc])
  );

  for (const doc of next.filter(isAgentLocalDoc)) {
    if (!merged.has(doc.role)) {
      merged.set(doc.role, doc);
    }
  }

  return [...merged.values()];
};

const packageKey = (pkg: ResolvedPackage): string => `${pkg.manager}::${pkg.name}`;
const skillKey = (skill: ResolvedSkill): string => skill.ref;

export const mergeCompatibleAgentNode = (
  existing: ResolvedAgentNode,
  next: ResolvedAgentNode
): void => {
  assertSame("description", existing.description, next.description, existing.name);
  assertSame("execution", existing.execution, next.execution, existing.name);
  assertSame("expose", existing.expose, next.expose, existing.name);
  assertSame("memory", existing.memory, next.memory, existing.name);
  assertSame("name", existing.name, next.name, existing.name);
  assertSame("policy mode", existing.policyMode, next.policyMode, existing.name);
  assertSame("policy on_degrade", existing.policyOnDegrade, next.policyOnDegrade, existing.name);
  assertSame("runtime", existing.runtime, next.runtime, existing.name);
  assertSame("schedule", existing.schedule, next.schedule, existing.name);
  assertSame("source", existing.source, next.source, existing.name);
  assertSame("source path", existing.sourcePath, next.sourcePath, existing.name);
  assertSame("surfaces", existing.surfaces, next.surfaces, existing.name);

  existing.docs = mergeDocuments(
    existing.docs,
    next.docs,
    existing.sourcePath ?? existing.source
  );
  existing.env = mergeEnvStrict(existing.env, next.env, existing.name);
  existing.mcpServers = mergeByKeyStrict(
    existing.mcpServers,
    next.mcpServers,
    (server) => server.name,
    "MCP server",
    existing.name
  ) ?? [];
  existing.packages = mergeByKeyStrict(
    existing.packages,
    next.packages,
    packageKey,
    "package",
    existing.name
  );
  existing.secrets = mergeByKeyStrict(
    existing.secrets,
    next.secrets,
    (secret) => secret.name,
    "secret",
    existing.name
  ) ?? [];
  existing.skills = mergeByKeyStrict(
    existing.skills,
    next.skills,
    skillKey,
    "skill",
    existing.name
  ) ?? [];
  existing.workspaceResources = mergeWorkspaceResources(
    [
      ...(existing.workspaceResources ?? []),
      ...(next.workspaceResources ?? [])
    ],
    [],
    existing.name,
    {
      kind: "agent",
      key: existing.source,
      name: existing.name
    }
  );
};
