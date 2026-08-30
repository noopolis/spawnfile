import { resolveMnemeDurableMemoryMountPath } from "../runtime/mnemeMcp.js";
import { createExclusiveReattachVolumeName, SpawnfileError } from "../shared/index.js";

import { slugify } from "./helpers.js";
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
      // Mneme runs in-process for these runtimes (no MCP subprocess), but
      // whether that in-process runtime is reachable -- and whether it
      // persists anything -- depends on the store:
      //   - sqlite/json WITH a durable mount: a real runtime home backed by
      //     a persistent volume this same module emits.
      //   - sqlite/json WITHOUT one (persistence.mode "ephemeral", or no
      //     resolvable path at all): no volume is mounted and Daimon emits no
      //     memory block, so recall lasts at most the container's lifetime --
      //     exactly the "memory" kind's situation, and reported the same way.
      //   - memory: Mneme still runs in-process against a synthesized runtime
      //     home path, but no persistent volume is emitted for this kind.
      //   - postgres: no runtime home path at all; the in-process runtime
      //     gets no memory whatsoever.
      //
      // The durable/ephemeral half of that decision is NOT re-derived here:
      // it comes from resolveMnemeDurableMemoryMountPath, the same authority
      // that decides the mount below, so the report cannot disagree with what
      // was actually emitted.
      switch (bank.store.kind) {
        case "sqlite":
        case "json":
          return resolveMnemeDurableMemoryMountPath(bank) === null ? "degraded" : "direct";
        case "memory":
          return "degraded";
        default:
          return "unsupported";
      }
    case "picoclaw":
    case "openclaw":
      return isFileBackedMemoryStore(bank) ? "mcp" : "degraded_mcp";
    default:
      return "unsupported";
  }
};

// The mount decision itself lives in runtime/mnemeMcp.ts so that runtime config
// emitters (which must only point an in-process Mneme runtime at a path this
// module actually mounts) and this module cannot drift apart.
const memoryMountPath = resolveMnemeDurableMemoryMountPath;

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

interface DurableMemoryClaimant {
  bankId: string;
  identity: string;
  source: string;
}

/**
 * The identity of the PHYSICAL store a declared bank resolves to.
 *
 * Mneme addresses a store by its runtime home directory and then discards the
 * declared filename: `JsonlMemoryStore` always writes `<home>/memory/events.jsonl`
 * and `SQLiteMemoryIndex` always opens `<home>/memory/<default>.db`
 * (mneme/src/store/store.ts, mneme/src/store/sqliteIndex.ts). Spawnfile resolves
 * that home as `dirname(store.path)` unless `persistence.mount` overrides it, so
 * `/data/mem/a.jsonl` and `/data/mem/b.jsonl` are ONE physical store wearing two
 * declared names — two concurrent MemoryRuntimes appending to one file and
 * opening one SQLite database.
 *
 * Two declarations may therefore share a durable directory only when they are
 * the same bank said twice (the legitimate case: one bank declared in an org
 * scope and again in a nested team scope so both sides can access it). Anything
 * that differs — a different id, a different declared file, a different index
 * intent — means the author believes they have two stores and the runtime will
 * silently give them one.
 */
const physicalStoreIdentity = (bank: ResolvedMemoryBank): string => JSON.stringify({
  consolidation: bank.consolidation,
  id: bank.id,
  index: bank.index,
  retention: bank.retention,
  store: {
    kind: bank.store.kind,
    mount: bank.store.persistence?.mount ?? null,
    name: bank.store.persistence?.name ?? null,
    path: bank.store.path ?? null
  }
});

const collidingBankMessage = (
  mountPath: string,
  prior: DurableMemoryClaimant,
  next: DurableMemoryClaimant
): string =>
  `Memory banks ${prior.bankId} (declared in ${prior.source}) and ${next.bankId} `
  + `(declared in ${next.source}) both resolve to the durable memory directory ${mountPath}, `
  + "but do not declare the same store. Mneme keys a store by that directory and ignores the "
  + "declared filename, so these two banks would silently become one physical store with two "
  + "runtimes writing it. Give each bank its own directory (a distinct store.path parent or "
  + "persistence.mount), or declare them identically if one shared bank is what you meant.";

/**
 * The docker volume name for a durable memory directory.
 *
 * Deliberately NOT run-scoped. `createPersistentVolumeName` folds NOOPOLIS_RUN_ID
 * into the name, and `ensureNoopolisRunId` mints a fresh id on every `spawnfile
 * run`/`up`, so a run-scoped memory volume means the organization you redeploy
 * tomorrow starts with an empty memory bank. There is no working escape hatch
 * today either: `spawnfile product-state clone` refuses SQLite paths, and reusing
 * yesterday's NOOPOLIS_RUN_ID to reproduce the volume name would collapse two
 * distinct causal runs onto one run_id in the ledger (specs/CAUSAL.md).
 *
 * `exclusive-reattach` is the existing lifecycle for exactly this: a host-stable
 * name derived from the project root plus the deployment lineage, with a
 * daemon-side reservation that refuses to start when another live container
 * already holds the volume (src/compiler/runProjectDockerReservation.ts). That
 * mutual exclusion is a requirement here rather than a cost — Mneme's append-only
 * JSONL plus its SQLite index are single-writer — and it is why an organization
 * with durable memory cannot use the concurrent blue/green canary workflow and
 * must stop-and-reattach instead (specs/CONTAINERS.md).
 *
 * An author-declared `persistence.name` is honored verbatim: naming a volume is
 * precisely a request for a host-stable identity.
 */
const durableMemoryVolumeName = (
  planRoot: string,
  mountId: string,
  declaredName: string | undefined,
  deploymentLineage: string
): string =>
  declaredName?.trim()
  || createExclusiveReattachVolumeName(`${planRoot}\0${deploymentLineage}`, mountId);

export interface MemoryArtifactBundle {
  mountPathMemoryMap: Map<string, string>;
  mounts: ContainerPersistentMountReport[];
  memories: MemoryArtifactSummary[];
}

export const createMemoryArtifactBundle = (
  plan: CompilePlan,
  deploymentLineage = "compile"
): MemoryArtifactBundle => {
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
  const claimantByPath = new Map<string, DurableMemoryClaimant>();

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
        const volumeName = durableMemoryVolumeName(
          plan.root,
          mountId,
          entry.bank.store.persistence?.name,
          deploymentLineage
        );
        const identity = physicalStoreIdentity(entry.bank);
        const claimant = { bankId: entry.bank.id, identity, source: entry.source };
        const priorClaimant = claimantByPath.get(mountPath);
        if (priorClaimant && priorClaimant.identity !== identity) {
          throw new SpawnfileError("validation_error", collidingBankMessage(mountPath, priorClaimant, claimant));
        }
        claimantByPath.set(mountPath, claimant);

        const existingMount = mountByPath.get(mountPath);
        if (existingMount && existingMount.volume_name !== volumeName) {
          throw new Error(
            `Memory store mount ${mountPath} resolves to conflicting volume names`
          );
        }

        const mount = existingMount ?? {
          id: mountId,
          lifecycle: "exclusive-reattach" as const,
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
