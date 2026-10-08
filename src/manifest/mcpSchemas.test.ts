import { describe, expect, it } from "vitest";

import { manifestSchema } from "./schemas.js";

const agent = (mcpServers: unknown[]) => ({
  environment: { mcp_servers: mcpServers },
  kind: "agent",
  name: "writer",
  spawnfile_version: "0.1"
});

const team = (mcpServers: unknown[]) => ({
  kind: "team",
  members: [{ id: "writer", ref: "./writer" }],
  mode: "swarm",
  name: "studio",
  shared: { environment: { mcp_servers: mcpServers } },
  spawnfile_version: "0.1"
});

const firstIssue = (value: unknown): string | undefined =>
  manifestSchema.safeParse(value).error?.issues[0]?.message;

describe("agent MCP server entries", () => {
  it("accepts a transport-less override selecting tools and env", () => {
    expect(manifestSchema.safeParse(agent([{ env: { A: "1" }, name: "workbench", tools: ["file_item"] }])).success).toBe(true);
  });

  it("requires an override to declare tools or env", () => {
    expect(firstIssue(agent([{ name: "workbench" }]))).toBe("MCP server override without transport must declare tools or env");
  });

  it("rejects server fields on an override instead of guessing a replacement", () => {
    expect(manifestSchema.safeParse(agent([{ command: "/bin/x", name: "workbench", tools: ["a"] }])).error?.issues[0]?.path)
      .toEqual(["environment", "mcp_servers", 0]);
  });

  it("keeps complete-server validation for entries that declare transport", () => {
    expect(firstIssue(agent([{ name: "workbench", tools: ["a"], transport: "stdio" }]))).toBe("stdio MCP servers must declare command");
  });

  it("keeps the tools allowlist and reserved-name rules on overrides", () => {
    expect(firstIssue(agent([{ name: "workbench", tools: ["a", "a"] }]))).toBe("MCP tools must be a nonempty unique allowlist");
    expect(firstIssue(agent([{ name: "mneme-x", tools: ["a"] }]))).toBe("MCP server name is reserved for compiler-owned generated services");
  });

  it("does not allow overrides in shared.environment, which has nothing to inherit from", () => {
    expect(manifestSchema.safeParse(team([{ name: "workbench", tools: ["a"] }])).success).toBe(false);
  });
});
