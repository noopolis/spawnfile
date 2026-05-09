import type { TeamNetworkServer } from "../manifest/index.js";

export interface MoltnetSecretPatch {
  envName: string;
  jsonPath: string;
}

export interface MoltnetClientAuthPlan {
  mode: "bearer" | "none" | "open";
  staticToken?: boolean;
  tokenEnv?: string;
  tokenPath?: string;
}

export interface MoltnetNativeRoomConfig {
  id: string;
  members: string[];
  name?: string;
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

export const createMoltnetOpenTokenPath = (networkId: string, memberId: string): string =>
  `/var/lib/spawnfile/moltnet/tokens/${pathSafeSegment(networkId)}/${pathSafeSegment(memberId)}.token`;

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
  memberId: string
): MoltnetClientAuthPlan => {
  if (server.auth.mode === "none") {
    return { mode: "none" };
  }

  const client = server.auth.client;
  if (server.auth.mode === "open" && !client) {
    return {
      mode: "open",
      tokenPath: createMoltnetOpenTokenPath(networkId, memberId)
    };
  }

  if (!client) {
    return { mode: server.auth.mode };
  }

  const tokenEnv = client.token_env
    ?? (client.token_id && server.mode === "managed"
      ? server.auth.tokens?.find((token) => token.id === client.token_id)?.secret
      : undefined);

  return {
    mode: server.auth.mode,
    ...(client.static_token ? { staticToken: true } : {}),
    ...(tokenEnv ? { tokenEnv } : {}),
    ...(client.token_path ? { tokenPath: client.token_path } : {})
  };
};

const storageConfigFor = (
  store: Extract<TeamNetworkServer, { mode: "managed" }>["store"]
): Record<string, unknown> => {
  switch (store.kind) {
    case "sqlite":
      return { kind: "sqlite", sqlite: { path: store.path } };
    case "json":
      return { kind: "json", json: { path: store.path } };
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
        ...(server.human_ingress !== undefined ? { human_ingress: server.human_ingress } : {}),
        ...(server.direct_messages !== undefined ? { direct_messages: server.direct_messages } : {}),
        ...(server.trust_forwarded_proto !== undefined
          ? { trust_forwarded_proto: server.trust_forwarded_proto }
          : {}),
        ...(server.allowed_origins ? { allowed_origins: server.allowed_origins } : {})
      },
      auth: {
        mode: server.auth.mode,
        ...(tokens.length > 0 ? { tokens } : {})
      },
      storage: storageConfigFor(server.store),
      rooms: rooms.map((room) => ({
        id: room.id,
        ...(room.name ? { name: room.name } : {}),
        members: room.members
      })),
      ...(pairings.length > 0 ? { pairings } : {})
    },
    secretPatches
  };
};
