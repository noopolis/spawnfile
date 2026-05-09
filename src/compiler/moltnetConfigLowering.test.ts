import { describe, expect, it } from "vitest";

import type { TeamNetworkServer } from "../manifest/index.js";

import {
  createMoltnetNativeServerConfig,
  createMoltnetNodeConfigPath,
  createMoltnetOpenTokenPath,
  createMoltnetServerConfigPath,
  renderMoltnetListenAddr,
  resolveMoltnetBaseUrl,
  resolveMoltnetClientAuth
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
    expect(createMoltnetOpenTokenPath("org net", "field/rep"))
      .toBe("/var/lib/spawnfile/moltnet/tokens/org-net/field-rep.token");
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
    }), "org", "agent")).toEqual({
      mode: "open",
      tokenPath: "/var/lib/spawnfile/moltnet/tokens/org/agent.token"
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

  it("lowers managed server config with secrets and pairing patches", () => {
    const lowered = createMoltnetNativeServerConfig({
      networkId: "org",
      networkName: "Org",
      rooms: [{ id: "agora", members: ["lead"], name: "Agora" }],
      server: createManagedServer({
        allowed_origins: ["https://console.example.com"],
        auth: {
          mode: "bearer",
          tokens: [
            {
              agents: ["lead"],
              id: "writer",
              scopes: ["attach", "write", "observe"],
              secret: "MOLTNET_WRITER_TOKEN"
            }
          ]
        },
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
        mode: "bearer",
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
      rooms: [{ id: "agora", members: ["lead"], name: "Agora" }],
      server: {
        allowed_origins: ["https://console.example.com"],
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
});
