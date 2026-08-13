import { describe, expect, it } from "vitest";

import type { TeamNetworkServer } from "../manifest/index.js";

import {
  createMoltnetNativeServerConfig,
  createDefaultMoltnetStorePath,
  createMoltnetNodeConfigPath,
  createMoltnetOpenTokenDirectory,
  createMoltnetOpenTokenPath,
  createMoltnetServerConfigPath,
  renderMoltnetListenAddr,
  resolveMoltnetBaseUrl,
  resolveMoltnetClientAuth,
  resolveMoltnetStorePersistenceMountPath
} from "./moltnetConfigLowering.js";

type ManagedServer = Extract<TeamNetworkServer, { mode: "managed" }>;

const createManagedServer = (
  overrides: Partial<ManagedServer> = {}
): ManagedServer => ({
  auth: { mode: "none" },
  listen: { bind: "127.0.0.1", port: 8787 },
  mode: "managed",
  store: { kind: "memory" },
  ...overrides
});

describe("moltnetConfigLowering", () => {
  it("renders stable config and token paths", () => {
    expect(createMoltnetOpenTokenDirectory("field rep"))
      .toBe("/var/lib/spawnfile/agents/field-rep/state/moltnet");
    expect(createMoltnetOpenTokenPath("org net", "field/rep", "field rep"))
      .toBe("/var/lib/spawnfile/agents/field-rep/state/moltnet/org-net-field-rep.token");
    expect(createMoltnetServerConfigPath("org net"))
      .toBe("container/rootfs/var/lib/spawnfile/moltnet/servers/org-net/Moltnet.json");
    expect(createMoltnetNodeConfigPath("root team", "org net", "field/rep"))
      .toBe("container/rootfs/var/lib/spawnfile/moltnet/nodes/root-team-org-net-field-rep.json");
  });

  it("renders listen addresses and base URLs for managed and external servers", () => {
    expect(renderMoltnetListenAddr(createManagedServer())).toBe("127.0.0.1:8787");
    expect(renderMoltnetListenAddr(createManagedServer({
      listen: { bind: "::1", port: 8788 }
    }))).toBe("[::1]:8788");
    expect(resolveMoltnetBaseUrl(createManagedServer({
      listen: { bind: "0.0.0.0", port: 8789 }
    }))).toBe("http://127.0.0.1:8789");
    expect(resolveMoltnetBaseUrl(createManagedServer({
      listen: { bind: "::1", port: 8790 }
    }))).toBe("http://[::1]:8790");
    expect(resolveMoltnetBaseUrl(createManagedServer({
      url: " https://moltnet.example.com "
    }))).toBe("https://moltnet.example.com");
    expect(resolveMoltnetBaseUrl({
      auth: { mode: "none" },
      mode: "external",
      url: "https://remote.example.com"
    })).toBe("https://remote.example.com");
  });

  it("resolves client auth for none, open self-claim, bearer, and external token sources", () => {
    expect(resolveMoltnetClientAuth(createManagedServer(), "org", "agent"))
      .toEqual({ mode: "none" });
    expect(resolveMoltnetClientAuth(createManagedServer({
      auth: { mode: "open" }
    }), "org", "agent", "agent-slug")).toEqual({
      mode: "open",
      registration: "open",
      tokenPath: "/var/lib/spawnfile/agents/agent-slug/state/moltnet/org-agent.token"
    });
    expect(resolveMoltnetClientAuth(createManagedServer({
      auth: {
        agent_registration: "open",
        mode: "bearer",
        public_read: true,
        tokens: [
          {
            id: "admin",
            scopes: ["admin", "write"],
            secret: "MOLTNET_ADMIN_TOKEN"
          }
        ]
      }
    }), "org", "agent", "agent-slug")).toEqual({
      mode: "open",
      registration: "open",
      tokenPath: "/var/lib/spawnfile/agents/agent-slug/state/moltnet/org-agent.token"
    });
    expect(resolveMoltnetClientAuth({
      auth: {
        agent_registration: "open",
        mode: "bearer",
        public_read: true
      },
      mode: "external",
      url: "https://public.example.com"
    }, "public", "guest", "guest-slug")).toEqual({
      mode: "open",
      registration: "open",
      tokenPath: "/var/lib/spawnfile/agents/guest-slug/state/moltnet/public-guest.token"
    });
    expect(resolveMoltnetClientAuth(createManagedServer({
      auth: {
        client: { token_id: "writer" },
        mode: "bearer",
        tokens: [
          {
            id: "writer",
            scopes: ["attach", "write"],
            secret: "MOLTNET_WRITER_TOKEN"
          }
        ]
      }
    }), "org", "agent")).toEqual({
      credentialId: "writer",
      mode: "bearer",
      tokenEnv: "MOLTNET_WRITER_TOKEN"
    });
    expect(resolveMoltnetClientAuth({
      auth: {
        client: { token_path: "/run/secrets/moltnet-token" },
        mode: "bearer"
      },
      mode: "external",
      url: "https://remote.example.com"
    }, "remote", "agent")).toEqual({
      mode: "bearer",
      tokenPath: "/run/secrets/moltnet-token"
    });
    expect(resolveMoltnetClientAuth({
      auth: {
        client: { static_token: true, token_env: "MOLTNET_STATIC_TOKEN" },
        mode: "open"
      },
      mode: "external",
      url: "https://remote.example.com"
    }, "remote", "agent")).toEqual({
      mode: "open",
      staticToken: true,
      tokenEnv: "MOLTNET_STATIC_TOKEN"
    });
  });

  it("binds explicit attachment tokens to exactly one member and rejects operator fallback", () => {
    const server = createManagedServer({
      auth: {
        agent_registration: "disabled",
        client: { token_id: "world" },
        mode: "bearer",
        tokens: [
          {
            agents: ["red"],
            id: "red-agent",
            scopes: ["attach", "write"],
            secret: "RED_TOKEN"
          },
          {
            agents: ["world"],
            id: "world",
            scopes: ["observe", "write"],
            secret: "WORLD_TOKEN"
          }
        ]
      }
    });

    expect(resolveMoltnetClientAuth(
      server,
      "pitch",
      "red",
      "red",
      "red-agent"
    )).toEqual({
      credentialAgentId: "red",
      credentialId: "red-agent",
      mode: "bearer",
      registration: "disabled",
      tokenEnv: "RED_TOKEN"
    });
    expect(() => resolveMoltnetClientAuth(server, "pitch", "red", "red"))
      .toThrow(/must select its own attach\+write token/);

    const shared = createManagedServer({
      auth: {
        client: { token_id: "shared" },
        mode: "bearer",
        tokens: [{
          agents: ["red", "blue"],
          id: "shared",
          scopes: ["attach", "write"],
          secret: "SHARED_TOKEN"
        }]
      }
    });
    expect(() => resolveMoltnetClientAuth(
      shared,
      "pitch",
      "red",
      "red",
      "shared"
    )).toThrow(/actor token/u);
  });

  it("rejects unsafe explicit actor-token selections outside B31 mode", () => {
    const server = createManagedServer({
      auth: {
        client: { token_id: "operator" },
        mode: "bearer",
        tokens: [
          { id: "operator", scopes: ["admin", "observe", "write"], secret: "OPERATOR_ENV" },
          { agents: ["red"], id: "red", scopes: ["attach", "write"], secret: "RED_ENV" },
          { agents: ["red"], id: "wrong-scope", scopes: ["attach"], secret: "WRONG_SCOPE_ENV" },
          { agents: ["red"], id: "extra-scope", scopes: ["attach", "write", "admin"], secret: "EXTRA_SCOPE_ENV" },
          { agents: ["blue"], id: "wrong-agent", scopes: ["attach", "write"], secret: "WRONG_AGENT_ENV" },
          { agents: ["red", "blue"], id: "shared", scopes: ["attach", "write"], secret: "SHARED_ENV" },
          { id: "unbound", scopes: ["attach", "write"], secret: "UNBOUND_ENV" }
        ]
      }
    });

    expect(resolveMoltnetClientAuth(server, "pitch", "red", undefined, "red"))
      .toEqual({
        credentialAgentId: "red",
        credentialId: "red",
        mode: "bearer",
        tokenEnv: "RED_ENV"
      });
    for (const tokenId of ["operator", "wrong-scope", "extra-scope", "wrong-agent", "shared", "unbound", "missing", ""]) {
      expect.soft(
        () => resolveMoltnetClientAuth(server, "pitch", "red", undefined, tokenId),
        tokenId
      ).toThrow(/actor token/u);
    }

    const duplicate = structuredClone(server);
    duplicate.auth.tokens?.push({
      agents: ["red"],
      id: "red",
      scopes: ["attach", "write"],
      secret: "RED_ENV_2"
    });
    expect(() => resolveMoltnetClientAuth(duplicate, "pitch", "red", undefined, "red"))
      .toThrow(/actor token/u);
    expect(resolveMoltnetClientAuth(createManagedServer({
      auth: {
        agent_registration: "open",
        mode: "bearer",
        tokens: [{ agents: ["red"], id: "red", scopes: ["attach", "write"], secret: "RED_ENV" }]
      }
    }), "pitch", "red", undefined, "red")).toEqual({
      credentialAgentId: "red",
      credentialId: "red",
      mode: "bearer",
      registration: "open",
      tokenEnv: "RED_ENV"
    });
    expect(() => resolveMoltnetClientAuth({
      auth: { client: { token_env: "REMOTE_ENV" }, mode: "bearer" },
      mode: "external",
      url: "https://moltnet.example"
    }, "pitch", "red", undefined, "red")).toThrow(/actor token/u);

    const isolated = structuredClone(server);
    isolated.auth.client = { static_token: true, token_path: "/topology/operator.token" };
    expect(resolveMoltnetClientAuth(isolated, "pitch", "red", undefined, "red"))
      .toEqual({
        credentialAgentId: "red",
        credentialId: "red",
        mode: "bearer",
        tokenEnv: "RED_ENV"
      });
  });

  it("lowers managed server config with secrets and pairing patches", () => {
    const lowered = createMoltnetNativeServerConfig({
      networkId: "org",
      networkName: "Org",
      rooms: [
        {
          id: "agora",
          members: ["lead"],
          name: "Agora",
          visibility: "public",
          write_policy: "members"
        }
      ],
      server: createManagedServer({
        allowed_origins: ["https://console.example.com"],
        auth: {
          agent_registration: "disabled",
          mode: "bearer",
          public_read: true,
          tokens: [
            {
              agents: ["lead"],
              id: "writer",
              scopes: ["attach", "write", "observe"],
              secret: "MOLTNET_WRITER_TOKEN"
            }
          ]
        },
        console: {
          analytics: {
            provider: "google",
            measurement_id: "G-ABC123"
          }
        },
        debug_events: true,
        direct_messages: false,
        human_ingress: true,
        pairings: [
          {
            id: "remote",
            remote_base_url: "https://remote.example.com",
            remote_network_id: "remote-org",
            remote_network_name: "Remote Org",
            token_secret: "REMOTE_PAIR_TOKEN"
          }
        ],
        store: { dsn_secret: "MOLTNET_DATABASE_URL", kind: "postgres" },
        trust_forwarded_proto: true
      })
    });

    expect(lowered.secretPatches).toEqual([
      { envName: "MOLTNET_WRITER_TOKEN", jsonPath: "auth.tokens.0.value" },
      { envName: "REMOTE_PAIR_TOKEN", jsonPath: "pairings.0.token" },
      { envName: "MOLTNET_DATABASE_URL", jsonPath: "storage.postgres.dsn" }
    ]);
    expect(lowered.config).toMatchObject({
      auth: {
        agent_registration: "disabled",
        mode: "bearer",
        public_read: true,
        tokens: [
          {
            agents: ["lead"],
            id: "writer",
            scopes: ["attach", "write", "observe"],
            value: ""
          }
        ]
      },
      network: { id: "org", name: "Org" },
      pairings: [
        {
          id: "remote",
          remote_base_url: "https://remote.example.com",
          remote_network_id: "remote-org",
          remote_network_name: "Remote Org",
          token: ""
        }
      ],
      rooms: [
        {
          id: "agora",
          members: ["lead"],
          name: "Agora",
          visibility: "public",
          write_policy: "members"
        }
      ],
      server: {
        allowed_origins: ["https://console.example.com"],
        console: {
          analytics: {
            provider: "google",
            measurement_id: "G-ABC123"
          }
        },
        debug_events: true,
        direct_messages: false,
        human_ingress: true,
        listen_addr: "127.0.0.1:8787",
        trust_forwarded_proto: true
      },
      storage: { kind: "postgres", postgres: { dsn: "" } }
    });
  });

  it("lowers sqlite, json, and memory storage configs", () => {
    const sqlite = createMoltnetNativeServerConfig({
      networkId: "sqlite-net",
      networkName: "Sqlite",
      rooms: [],
      server: createManagedServer({ store: { kind: "sqlite", path: "/data/moltnet.sqlite" } })
    });
    const json = createMoltnetNativeServerConfig({
      networkId: "json-net",
      networkName: "Json",
      rooms: [],
      server: createManagedServer({ store: { kind: "json", path: "/data/moltnet.json" } })
    });
    const memory = createMoltnetNativeServerConfig({
      networkId: "memory-net",
      networkName: "Memory",
      rooms: [],
      server: createManagedServer()
    });

    expect(sqlite.config).toMatchObject({
      storage: { kind: "sqlite", sqlite: { path: "/data/moltnet.sqlite" } }
    });
    expect(json.config).toMatchObject({
      storage: { json: { path: "/data/moltnet.json" }, kind: "json" }
    });
    expect(memory.config).toMatchObject({ storage: { kind: "memory" } });
  });

  it("defaults managed file store paths and persistence mount paths", () => {
    expect(createDefaultMoltnetStorePath("org net", "sqlite"))
      .toBe("/var/lib/spawnfile/moltnet/networks/org-net/moltnet.sqlite");
    expect(createDefaultMoltnetStorePath("org net", "json", "/state/moltnet"))
      .toBe("/state/moltnet/state.json");

    expect(resolveMoltnetStorePersistenceMountPath("org net", { kind: "sqlite" }))
      .toBe("/var/lib/spawnfile/moltnet/networks/org-net");
    expect(resolveMoltnetStorePersistenceMountPath("org", {
      kind: "json",
      path: "/data/moltnet/state.json",
      persistence: { mode: "durable", mount: "/data/moltnet" }
    })).toBe("/data/moltnet");
    expect(resolveMoltnetStorePersistenceMountPath("org", {
      kind: "sqlite",
      persistence: { mode: "ephemeral" }
    })).toBeNull();
  });
});
