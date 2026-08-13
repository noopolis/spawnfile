import path from "node:path/posix";

import { resolveNoopolisRunId } from "../runtime/index.js";

import { slugify } from "./helpers.js";
import { createPersistentVolumeName } from "./moltnetArtifactPaths.js";
import type {
  CompilePlan,
  ResolvedMemoryAccess,
  ResolvedMemoryBank
} from "./types.js";
import type {
  ContainerMemoryTransport,
  ContainerPersistentMountReport
} from "../report/types.js";

type MemoryStoreKind = "json" | "memory" | "postgres" | "sqlite";

type MemoryArtifactSummary = {
  id: string;
  declaring_node_id: string;
  accessible_node_ids: string[];
  store: {
    kind: MemoryStoreKind;
    path?: string;
    persistence?: "durable" | "ephemeral";
    persistent_mount_id?: string;
    dsn_secret?: string;
  };
  index: ResolvedMemoryBank["index"];
  consolidation: ResolvedMemoryBank["consolidation"];
  retention: ResolvedMemoryBank["retention"];
  transport_by_node_id: Record<string, ContainerMemoryTransport>;
};

const normalizePosixPath = (value: string): string =>
  path.normalize(value).replace(/\/+$/u, "") || "/";

const safeSlug = (value: string): string =>
  slugify(value).trim() || "memory";

const createMountId = (mountPath: string): string =>
  `memory-${safeSlug(mountPath)}`;

const isFileBackedMemoryStore = (bank: ResolvedMemoryAccess["bank"]): boolean =>
  bank.store.kind === "sqlite" || bank.store.kind === "json";

const transportFromRuntime = (
  runtimeName: string | null | undefined,
  bank: ResolvedMemoryAccess["bank"]
): ContainerMemoryTransport => {
  switch (runtimeName) {
    case "pi":
    case "daimon":
      return "direct";
    case "picoclaw":
    case "openclaw":
      return isFileBackedMemoryStore(bank) ? "mcp" : "degraded_mcp";
    default:
      return "unsupported";
  }
};

const memoryMountPath = (
  bank: ResolvedMemoryAccess["bank"]
): string | null => {
  if (bank.store.kind !== "sqlite" && bank.store.kind !== "json") {
    return null;
  }

  if (bank.store.persistence?.mode === "ephemeral") {
    return null;
  }

  if (bank.store.persistence?.mount) {
    return normalizePosixPath(bank.store.persistence.mount);
  }

  return bank.store.path
    ? path.dirname(normalizePosixPath(bank.store.path))
    : null;
};

const summarizeMemoryStore = (bank: ResolvedMemoryAccess["bank"], mountId?: string) => {
  const persistenceMode = bank.store.kind === "sqlite" || bank.store.kind === "json"
    ? (bank.store.persistence?.mode ?? "durable")
    : undefined;

  return {
    kind: bank.store.kind,
    ...(bank.store.path ? { path: bank.store.path } : {}),
    ...(persistenceMode ? { persistence: persistenceMode } : {}),
    ...(mountId ? { persistent_mount_id: mountId } : {}),
    ...(bank.store.kind === "postgres" ? { dsn_secret: bank.store.dsn_secret } : {})
  };
};

export interface MemoryArtifactBundle {
  mountPathMemoryMap: Map<string, string>;
  mounts: ContainerPersistentMountReport[];
  memories: MemoryArtifactSummary[];
}

export const createMemoryArtifactBundle = (plan: CompilePlan): MemoryArtifactBundle => {
  // Run-scoping key for every derived volume name below (see
  // createPersistentVolumeName's doc comment in moltnetArtifactPaths.ts):
  // present whenever this compile was driven by `spawnfile run`/`up`
  // (which always call ensureNoopolisRunId() first), absent for a bare
  // `spawnfile compile`/`spawnfile build`.
  const runId = resolveNoopolisRunId(process.env);
  const sourceToNode = new Map(
    plan.nodes.map((node) => [node.value.source, node] as const)
  );
  const groupedMemory = new Map<string, { bank: ResolvedMemoryAccess["bank"]; source: string; accesses: ResolvedMemoryAccess[] }>();

  for (const access of plan.memoryAccess ?? []) {
    const key = `${access.source}::${access.bank.id}`;
    const existing = groupedMemory.get(key);
    if (existing) {
      existing.accesses.push(access);
    } else {
      groupedMemory.set(key, { bank: access.bank, source: access.source, accesses: [access] });
    }
  }

  const mounts: ContainerPersistentMountReport[] = [];
  const mountPathMemoryMap = new Map<string, string>();
  const mountByPath = new Map<string, ContainerPersistentMountReport>();

  const memories = [...groupedMemory.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, entry]) => {
      const declaringNode = sourceToNode.get(entry.source);
      if (!declaringNode) {
        return null;
      }

      const transportByNodeId: Record<string, ContainerMemoryTransport> = {};
      const accessibleNodeIds = new Set<string>();

      for (const access of entry.accesses) {
        const agentNode = sourceToNode.get(access.agentSource);
        if (!agentNode || agentNode.value.kind !== "agent") {
          continue;
        }
        const transport = transportFromRuntime(agentNode.runtimeName, entry.bank);
        transportByNodeId[agentNode.id] = transport;
        accessibleNodeIds.add(agentNode.id);
      }

      const declaringNodeId = declaringNode.id;
      const mountPath = memoryMountPath(entry.bank);
      let persistentMountId: string | undefined;

      if (mountPath !== null) {
        const mountId = createMountId(mountPath);
        // createPersistentVolumeName also folds in plan.root (previously
        // missing here entirely), so two different projects that happen to
        // share a mount-path convention no longer derive the same volume
        // name — the same isolation moltnet's own persistent mounts already
        // had before this change.
        const volumeName = createPersistentVolumeName(
          plan.root,
          mountId,
          entry.bank.store.persistence?.name,
          runId
        );
        const existingMount = mountByPath.get(mountPath);
        if (existingMount && existingMount.volume_name !== volumeName) {
          throw new Error(
            `Memory store mount ${mountPath} resolves to conflicting volume names`
          );
        }

        const mount = existingMount ?? {
          id: mountId,
          mount_path: mountPath,
          reason: `durable memory stores under ${mountPath}`,
          volume_name: volumeName
        };
        mountByPath.set(mountPath, mount);
        if (!existingMount) {
          mounts.push(mount);
        }
        persistentMountId = mount.id;
        mountPathMemoryMap.set(persistentMountId, mountPath);
      }

      return {
        id: entry.bank.id,
        declaring_node_id: declaringNodeId,
        accessible_node_ids: [...accessibleNodeIds].sort(),
        store: summarizeMemoryStore(entry.bank, persistentMountId),
        index: entry.bank.index,
        consolidation: entry.bank.consolidation,
        retention: entry.bank.retention,
        transport_by_node_id: transportByNodeId
      };
    })
    .filter((entry): entry is MemoryArtifactSummary => entry !== null)
    .sort((left, right) =>
      left.declaring_node_id.localeCompare(right.declaring_node_id)
      || left.id.localeCompare(right.id)
    );

  return {
    mountPathMemoryMap,
    memories,
    mounts: [...mounts].sort((left, right) =>
      left.id.localeCompare(right.id) || left.mount_path.localeCompare(right.mount_path)
    )
  };
};
