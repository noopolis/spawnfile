import { describe, expect, it } from "vitest";

import { isAgentManifest, isTeamManifest, manifestSchema } from "./schemas.js";

describe("manifestSchema", () => {
  it("accepts stdio MCP servers with a command", () => {
    const result = manifestSchema.parse({
      kind: "agent",
      mcp_servers: [
        {
          command: "uvx",
          name: "memory",
          transport: "stdio"
        }
      ],
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1"
    });

    expect(isAgentManifest(result)).toBe(true);
  });

  it("rejects stdio MCP servers without a command", () => {
    const result = manifestSchema.safeParse({
      kind: "agent",
      mcp_servers: [
        {
          name: "memory",
          transport: "stdio"
        }
      ],
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("must declare command");
  });

  it("rejects remote MCP servers without a url", () => {
    const result = manifestSchema.safeParse({
      kind: "agent",
      mcp_servers: [
        {
          name: "search",
          transport: "sse"
        }
      ],
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("must declare url");
  });

  it("identifies team manifests", () => {
    const result = manifestSchema.parse({
      kind: "team",
      members: [
        {
          id: "analyst",
          ref: "./agents/analyst"
        }
      ],
      name: "research-team",
      spawnfile_version: "0.1",
      structure: {
        mode: "swarm"
      }
    });

    expect(isTeamManifest(result)).toBe(true);
  });
});
