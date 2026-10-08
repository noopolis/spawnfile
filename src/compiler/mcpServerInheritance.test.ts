import { describe, expect, it } from "vitest";

import type { McpServer } from "../manifest/index.js";

import { resolveInheritedMcpServers } from "./mcpServerInheritance.js";

const shared: McpServer = {
  args: ["${workspace}/server.mjs"],
  command: "/usr/local/bin/node",
  env: { MODE: "shared", ROOT: "${workspace}" },
  name: "workbench",
  tools: ["read_item"],
  transport: "stdio"
};

const checker: McpServer = { command: "/bin/check", name: "checker", tools: ["check"], transport: "stdio" };

describe("resolveInheritedMcpServers", () => {
  it("inherits shared servers unchanged when the agent declares none", () => {
    expect(resolveInheritedMcpServers("writer", [shared], [])).toEqual([shared]);
  });

  it("narrows tools and merges env for a transport-less override", () => {
    expect(resolveInheritedMcpServers("writer", [shared], [
      { env: { EXTRA: "1", MODE: "local" }, name: "workbench", tools: ["file_item"] }
    ])).toEqual([{ ...shared, env: { EXTRA: "1", MODE: "local", ROOT: "${workspace}" }, tools: ["file_item"] }]);
  });

  it("keeps the inherited env when an override only selects tools", () => {
    const [server] = resolveInheritedMcpServers("writer", [shared], [{ name: "workbench", tools: ["file_item"] }]);
    expect(server).toEqual({ ...shared, tools: ["file_item"] });
  });

  it("replaces the inherited server wholesale when the local entry declares transport", () => {
    const local: McpServer = { name: "workbench", tools: ["x"], transport: "streamable_http", url: "https://example.test/mcp" };
    expect(resolveInheritedMcpServers("writer", [shared], [local])).toEqual([local]);
  });

  it("keeps inherited servers first and appends local-only servers", () => {
    const local: McpServer = { command: "/bin/true", name: "checker", tools: ["check"], transport: "stdio" };
    expect(resolveInheritedMcpServers("writer", [shared], [local]).map((server) => server.name))
      .toEqual(["workbench", "checker"]);
  });

  it("rejects an override with nothing to inherit, naming the agent", () => {
    expect(() => resolveInheritedMcpServers("writer", [], [{ name: "workbench", tools: ["x"] }]))
      .toThrow("Agent writer overrides MCP server workbench");
  });

  it("does not offer an opt_in shared server to members that do not list it", () => {
    expect(resolveInheritedMcpServers("editor", [shared, { ...checker, opt_in: true }], []))
      .toEqual([shared]);
  });

  it("gives an opt_in shared server, without the opt_in flag, to a member listing its bare name", () => {
    expect(resolveInheritedMcpServers("writer", [shared, { ...checker, opt_in: true }], [{ name: "checker" }]))
      .toEqual([shared, checker]);
  });

  it("opts in through a narrowing override too", () => {
    expect(resolveInheritedMcpServers("writer", [{ ...checker, opt_in: true }], [{ name: "checker", tools: ["other"] }]))
      .toEqual([{ ...checker, tools: ["other"] }]);
  });

  it("treats opt_in: false like the default and inherits the server", () => {
    expect(resolveInheritedMcpServers("editor", [{ ...checker, opt_in: false }], [])).toEqual([checker]);
  });
});

