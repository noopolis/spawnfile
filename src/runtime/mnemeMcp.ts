import { createHash } from "node:crypto";
import path from "node:path/posix";

import { slugify } from "../compiler/helpers.js";
import type { ResolvedAgentNode } from "../compiler/types.js";

export const MNEME_PACKAGE = "@noopolis/mneme@0.1.1";

type MnemeMcpMode = "awake" | "dream";
type MnemeMemoryAccess = NonNullable<ResolvedAgentNode["memoryAccess"]>[number];

interface MnemeMcpServerOptions {
  modes?: MnemeMcpMode[];
}

export const resolveMnemeMemoryRuntimeHomePath = (access: MnemeMemoryAccess): string | null => {
  const store = access.bank.store;
  if (store.kind !== "sqlite" && store.kind !== "json") {
    return null;
  }

  if (store.persistence?.mount) {
    return store.persistence.mount;
  }

  return store.path ? path.dirname(store.path) : null;
};

export const isMnemeMemoryAccessSupported = (access: MnemeMemoryAccess): boolean =>
  resolveMnemeMemoryRuntimeHomePath(access) !== null;

const memoryAccessKey = (access: MnemeMemoryAccess): string =>
  `${access.source}:${access.bank.id}`;

const sourceDiscriminatorFor = (access: MnemeMemoryAccess): string => {
  const nameSlug = slugify(`${access.declaringKind}-${access.bank.declaredName}`) || access.declaringKind;
  const sourceHash = createHash("sha256").update(access.source).digest("hex").slice(0, 8);
  return `${nameSlug}-${sourceHash}`;
};

const hasDuplicateBankId = (node: ResolvedAgentNode, access: MnemeMemoryAccess): boolean => {
  const keys = new Set(
    (node.memoryAccess ?? [])
      .filter(isMnemeMemoryAccessSupported)
      .filter((candidate) => candidate.bank.id === access.bank.id)
      .map(memoryAccessKey)
  );
  return keys.size > 1;
};

export const mnemeMemoryServerBaseName = (
  node: ResolvedAgentNode,
  access: MnemeMemoryAccess
): string => {
  const bankSlug = slugify(access.bank.id) || "memory";
  const sourceSuffix = hasDuplicateBankId(node, access) ? `-${sourceDiscriminatorFor(access)}` : "";
  return `mneme-${bankSlug}${sourceSuffix}`;
};

export const mnemeMemoryServerName = (
  node: ResolvedAgentNode,
  access: MnemeMemoryAccess,
  mode: MnemeMcpMode
): string => {
  const baseName = mnemeMemoryServerBaseName(node, access);
  return mode === "dream" ? `${baseName}-dream` : baseName;
};

const embeddingArgsFor = (access: MnemeMemoryAccess): string[] => {
  const vector = access.bank.index.vector;
  if (!vector.enabled || !vector.model) {
    return [];
  }

  const provider = vector.provider ?? "ollama";
  if (provider !== "ollama") {
    return [];
  }

  return [
    "--embedding-provider",
    provider,
    "--embedding-model",
    vector.model,
    ...(vector.base_url ? ["--embedding-base-url", vector.base_url] : []),
    ...(vector.dimensions ? ["--embedding-dimensions", String(vector.dimensions)] : []),
    ...(vector.timeout_ms ? ["--embedding-timeout-ms", String(vector.timeout_ms)] : [])
  ];
};

export const buildMnemeMemoryMcpServers = (
  node: ResolvedAgentNode,
  options: MnemeMcpServerOptions = {}
): Record<string, Record<string, unknown>> => {
  const result: Record<string, Record<string, unknown>> = {};
  const seen = new Set<string>();
  const modes = options.modes ?? ["awake"];

  for (const access of node.memoryAccess ?? []) {
    const runtimeHome = resolveMnemeMemoryRuntimeHomePath(access);
    if (!runtimeHome) {
      continue;
    }

    const key = `${access.source}:${access.bank.id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    for (const mode of modes) {
      const name = mnemeMemoryServerName(node, access, mode);
      result[name] = {
        enabled: true,
        command: "mneme",
        args: [
          "mcp",
          "--runtime-home",
          runtimeHome,
          "--agent-id",
          slugify(node.name) || "agent",
          "--mode",
          mode,
          "--source",
          `spawnfile:${access.declaringKind}:${access.bank.id}`,
          ...embeddingArgsFor(access)
        ]
      };
    }
  }

  return result;
};

export const hasScheduledMemoryConsolidation = (node: ResolvedAgentNode): boolean =>
  (node.memoryAccess ?? []).some((access) =>
    isMnemeMemoryAccessSupported(access) &&
    access.bank.consolidation.mode === "scheduled" &&
    Boolean(access.bank.consolidation.schedule)
  );

export const hasUnsupportedMnemeMemoryAccess = (node: ResolvedAgentNode): boolean => {
  const checked = new Set<string>();

  for (const access of node.memoryAccess ?? []) {
    const key = `${access.source}:${access.bank.id}`;
    if (checked.has(key)) {
      continue;
    }
    checked.add(key);

    if (!resolveMnemeMemoryRuntimeHomePath(access)) {
      return true;
    }
  }

  return false;
};
