import type { TeamNetworkServer } from "../manifest/index.js";
import { SpawnfileError } from "../shared/index.js";

export interface MoltnetSecretPatch {
  envName: string;
  jsonPath: string;
}

export interface MoltnetClientAuthPlan {
  credentialAgentId?: string;
  credentialId?: string;
  mode: "bearer" | "none" | "open";
  registration?: "disabled" | "open" | "token";
  staticToken?: boolean;
  tokenEnv?: string;
  tokenPath?: string;
}

export interface MoltnetNativeRoomConfig {
  federation?: "all" | "none" | string[];
  id: string;
  members: string[];
  name?: string;
  visibility?: "public" | "private";
  write_policy?: "members" | "operators" | "registered_agents";
}

export interface MoltnetNativeServerConfigInput {
  networkId: string;
  networkName: string;
  rooms: MoltnetNativeRoomConfig[];
  server: Extract<TeamNetworkServer, { mode: "managed" }>;
}

const pathSafeSegment = (value: string): string =>
  value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "item";

const isIpv6Literal = (value: string): boolean => value.includes(":");

const normalizePosixPath = (value: string): string =>
  value.replace(/\/+/g, "/").replace(/\/+$/u, "") || "/";

type ManagedMoltnetStore = Extract<TeamNetworkServer, { mode: "managed" }>["store"];

export const createMoltnetOpenTokenDirectory = (agentSlug: string): string =>
  `/var/lib/spawnfile/agents/${pathSafeSegment(agentSlug)}/state/moltnet`;

export const createMoltnetOpenTokenPath = (
  networkId: string,
  memberId: string,
  agentSlug: string = memberId
): string =>
  `${createMoltnetOpenTokenDirectory(agentSlug)}/${pathSafeSegment(networkId)}-${pathSafeSegment(memberId)}.token`;

export const createMoltnetNetworkStateDirectory = (networkId: string): string =>
  `/var/lib/spawnfile/moltnet/networks/${pathSafeSegment(networkId)}`;

export const createMoltnetDaimonReceiptStorePath = (networkId: string, memberId: string): string => {
  const network = pathSafeSegment(networkId);
  const member = pathSafeSegment(memberId);
  if (network !== networkId || member !== memberId || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/u.test(memberId)) {
    throw new SpawnfileError("validation_error", "invalid Daimon receipt-store path segment");
  }
  return `${createMoltnetNetworkStateDirectory(networkId)}/daimon-receipts/${member}.json`;
};

export const createDefaultMoltnetStorePath = (
  networkId: string,
  kind: "json" | "sqlite",
  mountPath?: string
): string => {
  const directory = mountPath
    ? normalizePosixPath(mountPath)
    : createMoltnetNetworkStateDirectory(networkId);
  return `${directory}/${kind === "sqlite" ? "moltnet.sqlite" : "state.json"}`;
};

export const resolveMoltnetStorePath = (
  networkId: string,
  store: ManagedMoltnetStore
): string | null => {
  if (store.kind !== "sqlite" && store.kind !== "json") {
    return null;
  }

  return store.path ?? createDefaultMoltnetStorePath(networkId, store.kind, store.persistence?.mount);
};

export const resolveMoltnetStorePersistenceMountPath = (
  networkId: string,
  store: ManagedMoltnetStore
): string | null => {
  if (store.kind !== "sqlite" && store.kind !== "json") {
    return null;
  }

  if (store.persistence?.mode === "ephemeral") {
    return null;
  }

  if (store.persistence?.mount) {
    return normalizePosixPath(store.persistence.mount);
  }

  const storePath = resolveMoltnetStorePath(networkId, store);
  return storePath ? storePath.slice(0, storePath.lastIndexOf("/")) || "/" : null;
};

export const createMoltnetServerConfigPath = (serverId: string): string =>
  `container/rootfs/var/lib/spawnfile/moltnet/servers/${pathSafeSegment(serverId)}/Moltnet.json`;

/**
 * Dedicated causal-log subdirectory, a SIBLING of (never the same directory
 * as) the server's own Moltnet.json config file. Deliberately kept separate
 * so a persistent volume mounted here (to survive container teardown/
 * restart, see moltnetArtifacts.ts's causal persistent mount) never masks a
 * rebuilt image's freshly-baked Moltnet.json — which carries secrets
 * patched in at container start via secretPatches — with a stale copy left
 * over in a prior run's volume. Takes the already-container-absolute
 * `configPath` (MoltnetServerPlan.configPath, post toContainerRootfsPath),
 * not the rootfs-prefixed emit path.
 */
export const createMoltnetCausalDirectory = (configPath: string): string =>
  `${configPath.slice(0, configPath.lastIndexOf("/")) || "/"}/causal`;

export const createMoltnetCausalEventsPath = (configPath: string): string =>
  `${createMoltnetCausalDirectory(configPath)}/causal.jsonl`;

export const createMoltnetNodeConfigPath = (
  teamSlug: string,
  networkId: string,
  agentId: string
): string =>
  `container/rootfs/var/lib/spawnfile/moltnet/nodes/${pathSafeSegment(teamSlug)}-${pathSafeSegment(networkId)}-${pathSafeSegment(agentId)}.json`;

export const renderMoltnetListenAddr = (
  server: Extract<TeamNetworkServer, { mode: "managed" }>
): string => {
  const bind = server.listen.bind;
  return `${isIpv6Literal(bind) ? `[${bind}]` : bind}:${server.listen.port}`;
};

export const resolveMoltnetBaseUrl = (server: TeamNetworkServer): string => {
  if (server.mode === "external") {
    return server.url;
  }

  if (server.url && server.url.trim().length > 0) {
    return server.url.trim();
  }

  const bind = server.listen.bind;
  const host = bind === "0.0.0.0" || bind === "::"
    ? "127.0.0.1"
    : isIpv6Literal(bind)
      ? `[${bind}]`
      : bind;
  return `http://${host}:${server.listen.port}`;
};

export const resolveMoltnetClientAuth = (
  server: TeamNetworkServer,
  networkId: string,
  memberId: string,
  agentSlug?: string,
  attachmentTokenId?: string,
  runtimeName?: string
): MoltnetClientAuthPlan => {
  if (server.auth.mode === "none") {
    if (attachmentTokenId !== undefined) {
      throw new SpawnfileError(
        "validation_error",
        `Moltnet attachment ${networkId}/${memberId} cannot select token ${attachmentTokenId} when auth.mode is none`
      );
    }
    return { mode: "none" };
  }

  if (attachmentTokenId !== undefined) {
    if (server.mode !== "managed" || server.auth.mode !== "bearer") {
      throw new SpawnfileError(
        "validation_error",
        `invalid Moltnet actor token ${attachmentTokenId} for ${memberId}: token_id is supported only for managed bearer servers`
      );
    }
    const tokens = server.auth.tokens?.filter(
      (candidate) => candidate.id === attachmentTokenId
    ) ?? [];
    const token = tokens[0];
    if (tokens.length === 0 || !token) {
      throw new SpawnfileError(
        "validation_error",
        `invalid Moltnet actor token ${attachmentTokenId} for ${memberId}: attachment ${networkId}/${memberId} references unknown token ${attachmentTokenId}`
      );
    }
    if (tokens.length !== 1) {
      throw new SpawnfileError(
        "validation_error",
        `invalid Moltnet actor token ${attachmentTokenId} for ${memberId}: token id must exist exactly once`
      );
    }
    const requiredScopes = runtimeName === "daimon"
      ? ["attach", "observe", "write"]
      : ["attach", "write"];
    if (token.scopes.length !== requiredScopes.length
      || token.scopes.some((scope, index) => scope !== requiredScopes[index])) {
      throw new SpawnfileError(
        "validation_error",
        `invalid Moltnet actor token ${attachmentTokenId} for ${memberId}: token must include ${requiredScopes.join(", ")} scopes exactly`
      );
    }
    if (token.agents?.length !== 1 || token.agents[0] !== memberId) {
      throw new SpawnfileError(
        "validation_error",
        `invalid Moltnet actor token ${attachmentTokenId} for ${memberId}: token must declare exactly agents: [${memberId}]`
      );
    }

    return {
      credentialAgentId: memberId,
      credentialId: token.id,
      mode: "bearer",
      ...(server.auth.agent_registration ? { registration: server.auth.agent_registration } : {}),
      tokenEnv: token.secret
    };
  }

  const client = server.auth.client;
  const registrationOpen = server.auth.mode === "open" || server.auth.agent_registration === "open";
  if (registrationOpen && !client) {
    return {
      mode: "open",
      registration: "open",
      tokenPath: createMoltnetOpenTokenPath(networkId, memberId, agentSlug)
    };
  }

  if (!client) {
    return {
      mode: server.auth.mode,
      ...(server.auth.agent_registration ? { registration: server.auth.agent_registration } : {})
    };
  }

  const selectedManagedToken = client.token_id && server.mode === "managed"
    ? server.auth.tokens?.find((token) => token.id === client.token_id)
    : undefined;
  if (
    server.mode === "managed"
    && server.auth.mode === "bearer"
    && selectedManagedToken
    && (
      !selectedManagedToken.scopes.includes("attach")
      || !selectedManagedToken.scopes.includes("write")
    )
  ) {
    throw new SpawnfileError(
      "validation_error",
      `Moltnet attachment ${networkId}/${memberId} must select its own attach+write token; auth.client token ${selectedManagedToken.id} is operator-only`
    );
  }
  if (
    selectedManagedToken
    && (selectedManagedToken.agents?.length ?? 0) > 0
    && !selectedManagedToken.agents?.includes(memberId)
  ) {
    throw new SpawnfileError(
      "validation_error",
      `Moltnet attachment ${networkId}/${memberId} is not allowed by auth.client token ${selectedManagedToken.id}`
    );
  }
  const tokenEnv = client.token_env ?? selectedManagedToken?.secret;
  const selectedAgents = selectedManagedToken
    ? [...new Set((selectedManagedToken.agents ?? []).map((agent) => agent.trim()))].filter(Boolean)
    : [];

  return {
    ...(selectedAgents.length === 1 ? { credentialAgentId: selectedAgents[0] } : {}),
    ...(client.token_id ? { credentialId: client.token_id } : {}),
    mode: server.auth.mode,
    ...(server.auth.agent_registration ? { registration: server.auth.agent_registration } : {}),
    ...(client.static_token ? { staticToken: true } : {}),
    ...(tokenEnv ? { tokenEnv } : {}),
    ...(client.token_path ? { tokenPath: client.token_path } : {})
  };
};

const storageConfigFor = (
  networkId: string,
  store: Extract<TeamNetworkServer, { mode: "managed" }>["store"]
): Record<string, unknown> => {
  switch (store.kind) {
    case "sqlite":
      return { kind: "sqlite", sqlite: { path: resolveMoltnetStorePath(networkId, store) } };
    case "json":
      return { kind: "json", json: { path: resolveMoltnetStorePath(networkId, store) } };
    case "postgres":
      return { kind: "postgres", postgres: { dsn: "" } };
    case "memory":
      return { kind: "memory" };
  }
};

export const createMoltnetNativeServerConfig = ({
  networkId,
  networkName,
  rooms,
  server
}: MoltnetNativeServerConfigInput): { config: Record<string, unknown>; secretPatches: MoltnetSecretPatch[] } => {
  const secretPatches: MoltnetSecretPatch[] = [];
  const tokens = (server.auth.tokens ?? []).map((token, index) => {
    secretPatches.push({
      envName: token.secret,
      jsonPath: `auth.tokens.${index}.value`
    });

    return {
      id: token.id,
      value: "",
      scopes: token.scopes,
      ...(token.agents ? { agents: token.agents } : {})
    };
  });

  const pairings = (server.pairings ?? []).map((pairing, index) => {
    secretPatches.push({
      envName: pairing.token_secret,
      jsonPath: `pairings.${index}.token`
    });
    if (pairing.relay) {
      secretPatches.push({
        envName: pairing.relay.token_secret,
        jsonPath: `pairings.${index}.relay.token`
      });
    }

    return {
      id: pairing.id,
      remote_network_id: pairing.remote_network_id,
      remote_network_name: pairing.remote_network_name,
      ...(pairing.remote_base_url ? { remote_base_url: pairing.remote_base_url } : {}),
      ...(pairing.relay
        ? { relay: { room: pairing.relay.room, token: "", url: pairing.relay.url } }
        : {}),
      token: ""
    };
  });

  if (server.store.kind === "postgres") {
    secretPatches.push({
      envName: server.store.dsn_secret,
      jsonPath: "storage.postgres.dsn"
    });
  }

  return {
    config: {
      version: "moltnet.v1",
      network: {
        id: networkId,
        name: networkName
      },
      server: {
        listen_addr: renderMoltnetListenAddr(server),
        ...(server.console ? { console: server.console } : {}),
        ...(server.human_ingress !== undefined ? { human_ingress: server.human_ingress } : {}),
        ...(server.direct_messages !== undefined ? { direct_messages: server.direct_messages } : {}),
        ...(server.debug_events !== undefined ? { debug_events: server.debug_events } : {}),
        ...(server.trust_forwarded_proto !== undefined
          ? { trust_forwarded_proto: server.trust_forwarded_proto }
          : {}),
        ...(server.allowed_origins ? { allowed_origins: server.allowed_origins } : {})
      },
      auth: {
        mode: server.auth.mode,
        ...(server.auth.public_read !== undefined ? { public_read: server.auth.public_read } : {}),
        ...(server.auth.agent_registration ? { agent_registration: server.auth.agent_registration } : {}),
        ...(tokens.length > 0 ? { tokens } : {})
      },
      storage: storageConfigFor(networkId, server.store),
      rooms: rooms.map((room) => ({
        ...(room.federation !== undefined
          ? { federation: room.federation }
          : pairings.length > 0
            ? { federation: "none" }
            : {}),
        id: room.id,
        ...(room.name ? { name: room.name } : {}),
        ...(room.visibility ? { visibility: room.visibility } : {}),
        ...(room.write_policy ? { write_policy: room.write_policy } : {}),
        members: room.members
      })),
      ...(pairings.length > 0 ? { pairings } : {})
    },
    secretPatches
  };
};
