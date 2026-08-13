import { SpawnfileError } from "../shared/index.js";

import type {
  CompilePlan,
  ResolvedAgentNode,
  ResolvedMemoryAccess,
  ResolvedMemoryBank,
  ResolvedTeamNode
} from "./types.js";
import type {
  MemoryBank,
  MemoryConsolidation,
  MemoryIndex,
  MemoryRetention,
  MemoryStore
} from "../manifest/index.js";
import { slugify } from "./helpers.js";

const resolveMemoryIndex = (index?: MemoryIndex): ResolvedMemoryBank["index"] => ({
  graph: {
    enabled: index?.graph?.enabled ?? false,
    ...(index?.graph?.kind ? { kind: index.graph.kind } : {})
  },
  lexical: {
    enabled: index?.lexical?.enabled ?? true,
    ...(index?.lexical?.engine ? { engine: index.lexical.engine } : {})
  },
  rerank: {
    enabled: index?.rerank?.enabled ?? false
  },
  vector: {
    ...(index?.vector?.base_url ? { base_url: index.vector.base_url } : {}),
    dimensions: index?.vector?.dimensions,
    enabled: index?.vector?.enabled ?? false,
    ...(index?.vector?.model ? { model: index.vector.model } : {}),
    ...(index?.vector?.provider ? { provider: index.vector.provider } : {}),
    ...(index?.vector?.timeout_ms ? { timeout_ms: index.vector.timeout_ms } : {})
  }
});

const resolveMemoryConsolidation = (
  consolidation?: MemoryConsolidation
): ResolvedMemoryBank["consolidation"] => ({
  mode: consolidation?.mode ?? "disabled",
  ...(consolidation?.schedule ? { schedule: consolidation.schedule } : {}),
  ...(consolidation?.summarize_after_events
    ? { summarize_after_events: consolidation.summarize_after_events }
    : {})
});

const resolveMemoryRetention = (retention?: MemoryRetention): ResolvedMemoryBank["retention"] => ({
  forgetting: retention?.forgetting ?? "manual",
  ...(retention?.ttl ? { ttl: retention.ttl } : {})
});

const resolveMemoryStore = (store: MemoryStore, manifestName: string, bankId: string): ResolvedMemoryBank["store"] => {
  const manifestSlug = slugify(manifestName) || "memory";
  const baseDirectory = `/var/lib/spawnfile/memory/${manifestSlug}/${bankId}`;

  if (store.kind === "sqlite" || store.kind === "json") {
    return {
      kind: store.kind,
      path: store.path ?? `${baseDirectory}/${store.kind === "sqlite" ? "memory.sqlite" : "memory.jsonl"}`,
      ...(store.persistence
        ? {
            persistence: {
              mode: store.persistence.mode,
              ...(store.persistence.mount ? { mount: store.persistence.mount } : {}),
              ...(store.persistence.name ? { name: store.persistence.name } : {})
            }
          }
        : {
            persistence: {
              mode: "durable"
            }
          })
    };
  }

  if (store.kind === "postgres") {
    return {
      kind: store.kind,
      dsn_secret: store.dsn_secret
    };
  }

  return { kind: "memory" };
};

export const resolveDeclaredMemoryBanks = (
  memory: MemoryBank[] | undefined,
  source: string,
  declaredBy: "agent" | "team",
  manifestName: string
): ResolvedMemoryBank[] =>
  (memory ?? []).map((entry) => ({
    access: entry.access,
    consolidation: resolveMemoryConsolidation(entry.consolidation),
    declaredBy,
    declaredName: manifestName,
    id: entry.id,
    index: resolveMemoryIndex(entry.index),
    retention: resolveMemoryRetention(entry.retention),
    source,
    store: resolveMemoryStore(entry.store, manifestName, entry.id)
  }));

const getAgentNodes = (plan: CompilePlan): Map<string, ResolvedAgentNode> =>
  new Map(
    plan.nodes
      .filter((node) => node.value.kind === "agent")
      .map((node) => [node.value.source, node.value as ResolvedAgentNode])
  );

const getTeamNodes = (plan: CompilePlan): Map<string, ResolvedTeamNode> =>
  new Map(
    plan.nodes
      .filter((node) => node.value.kind === "team")
      .map((node) => [node.value.source, node.value as ResolvedTeamNode])
  );

const resolveTeamMembersForBank = (
  team: ResolvedTeamNode,
  members?: string[]
): string[] => {
  if (members !== undefined) {
    return members;
  }

  return team.members.filter((member) => member.kind === "agent").map((member) => member.id);
};

export const resolvePlanMemoryAccess = (plan: CompilePlan): void => {
  const agentBySource = getAgentNodes(plan);
  const teamBySource = getTeamNodes(plan);

  const memoryAccess: ResolvedMemoryAccess[] = [];

  for (const agent of agentBySource.values()) {
    for (const bank of agent.memory ?? []) {
      memoryAccess.push({
        agentSource: agent.source,
        declaringKind: "agent",
        source: bank.source,
        bank
      });
    }
  }

  for (const team of teamBySource.values()) {
    for (const bank of team.memory ?? []) {
      const allowedMembers = resolveTeamMembersForBank(team, bank.access?.members);
      const validMemberIds = new Set(team.members.map((member) => member.id));

      if (bank.access?.members) {
        for (const memberId of bank.access.members) {
          if (!validMemberIds.has(memberId)) {
            throw new SpawnfileError(
              "validation_error",
              `Team ${team.name} memory bank ${bank.id} references unknown member ${memberId}`
            );
          }
        }
      }

      for (const memberId of allowedMembers) {
        const member = team.members.find((memberRef) => memberRef.id === memberId);
        if (!member || member.kind !== "agent") {
          continue;
        }

        const agentNode = agentBySource.get(member.nodeSource);
        if (!agentNode) {
          throw new SpawnfileError(
            "validation_error",
            `Unable to resolve agent member ${memberId} in team ${team.name} for memory bank ${bank.id}`
          );
        }

        memoryAccess.push({
          agentSource: agentNode.source,
          declaringKind: "team",
          slotId: memberId,
          source: team.source,
          bank
        });
      }
    }
  }

  if (memoryAccess.length === 0) {
    return;
  }

  const uniqueAccess = new Map<string, ResolvedMemoryAccess>();
  for (const access of memoryAccess) {
    const key = `${access.agentSource}::${access.declaringKind}::${access.source}::${access.bank.id}::${access.slotId ?? ""}`;
    uniqueAccess.set(key, access);
  }

  plan.memoryAccess = [...uniqueAccess.values()].sort((left, right) =>
    `${left.agentSource}:${left.bank.id}:${left.source}:${left.slotId ?? ""}`.localeCompare(
      `${right.agentSource}:${right.bank.id}:${right.source}:${right.slotId ?? ""}`
    )
  );

  for (const agent of agentBySource.values()) {
    const access = plan.memoryAccess.filter((entry) => entry.agentSource === agent.source);
    if (access.length > 0) {
      agent.memoryAccess = access;
    }
  }
};
