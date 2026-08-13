import { describe, expect, it } from "vitest";

import {
  buildPicoClawAuthoredMcpServers,
  buildPicoClawMcpEnvBindings
} from "./mcp.js";

describe("PicoClaw MCP lowering", () => {
  it("constructs ordinary remote, legacy-header, bearer, stdio, dotted, and proto servers", () => {
    const servers = [
      { name: "ordinary", transport: "sse" as const, url: "https://ordinary.test/mcp" },
      {
        auth: { secret: "LEGACY_TOKEN" },
        name: "legacy",
        transport: "streamable_http" as const,
        url: "https://legacy.test/mcp"
      },
      {
        auth: { mode: "bearer" as const, secret: "BEARER_TOKEN" },
        name: "bearer",
        transport: "sse" as const,
        url: "https://bearer.test/mcp"
      },
      { args: ["server.js"], command: "node", name: "stdio", transport: "stdio" as const },
      {
        auth: { mode: "bearer" as const, secret: "DOTTED_TOKEN" },
        name: "a.b",
        transport: "sse" as const,
        url: "https://dotted.test/mcp"
      },
      {
        auth: { mode: "bearer" as const, secret: "PROTO_TOKEN" },
        name: "__proto__",
        transport: "sse" as const,
        url: "https://proto.test/mcp"
      }
    ];
    const result = buildPicoClawAuthoredMcpServers(servers);

    expect(result.ordinary).toEqual({ enabled: true, type: "sse", url: "https://ordinary.test/mcp" });
    expect(result.legacy.headers).toEqual({ LEGACY_TOKEN: "" });
    expect(result.bearer.headers).toEqual({ Authorization: "" });
    expect(result.stdio).toEqual({ args: ["server.js"], command: "node", enabled: true });
    expect(Object.prototype.hasOwnProperty.call(result, "a.b")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(result, "__proto__")).toBe(true);
  });

  it("binds legacy and bearer auth to unconditional structured paths", () => {
    expect(buildPicoClawMcpEnvBindings([
      { auth: { secret: "LEGACY_TOKEN" }, name: "a.b", transport: "sse", url: "https://example.test" },
      { auth: { mode: "bearer", secret: "BEARER_TOKEN" }, name: "__proto__", transport: "sse", url: "https://example.test" }
    ])).toEqual([
      {
        envName: "LEGACY_TOKEN",
        jsonPath: ["tools", "mcp", "servers", "a.b", "headers", "LEGACY_TOKEN"]
      },
      {
        envName: "BEARER_TOKEN",
        jsonPath: ["tools", "mcp", "servers", "__proto__", "headers", "Authorization"],
        transform: "bearer"
      }
    ]);
  });

  it("rejects explicit bearer auth on stdio while retaining legacy stdio auth", () => {
    expect(() => buildPicoClawAuthoredMcpServers([
      { auth: { secret: "LEGACY_TOKEN" }, command: "node", name: "legacy", transport: "stdio" }
    ])).not.toThrow();
    expect(() => buildPicoClawAuthoredMcpServers([
      { auth: { mode: "bearer", secret: "TOKEN" }, command: "node", name: "bad", transport: "stdio" }
    ])).toThrow("stdio MCP servers do not support bearer auth");
  });
});
