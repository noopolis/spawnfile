import type { TeamNetworkServer } from "../manifest/index.js";

export interface MoltnetSecretPatch {
  envName: string;
  jsonPath: string;
}

export interface MoltnetClientAuthPlan {
  mode: "bearer" | "none" | "open";
  registration?: "disabled" | "open" | "token";
  staticToken?: boolean;
  tokenEnv?: string;
  tokenPath?: string;
}

export interface MoltnetNativeRoomConfig {
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
  agentSlug?: string
): MoltnetClientAuthPlan => {
  if (server.auth.mode === "none") {
    return { mode: "none" };
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

  const tokenEnv = client.token_env
    ?? (client.token_id && server.mode === "managed"
      ? server.auth.tokens?.find((token) => token.id === client.token_id)?.secret
      : undefined);

  return {
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

    return {
      id: pairing.id,
      remote_network_id: pairing.remote_network_id,
      remote_network_name: pairing.remote_network_name,
      remote_base_url: pairing.remote_base_url,
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
