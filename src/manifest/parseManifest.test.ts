import { describe, expect, it } from "vitest";

import { parseManifest } from "./parseManifest.js";

const PATH = "/org/agents/writer/Spawnfile";

describe("parseManifest", () => {
  it("names the file, kind, agent and failing field of a schema error", () => {
    expect(() => parseManifest([
      'spawnfile_version: "0.1"', "kind: agent", "name: writer",
      "environment: { mcp_servers: [{ name: tool, transport: stdio, tools: [a] }] }"
    ].join("\n"), PATH)).toThrow(
      `Invalid Spawnfile manifest for agent writer (${PATH}) at environment.mcp_servers.0: stdio MCP servers must declare command`
    );
  });

  it("falls back to the file path when the manifest has no name", () => {
    expect(() => parseManifest('spawnfile_version: "0.1"\nkind: agent\n', PATH))
      .toThrow(`Invalid Spawnfile manifest for ${PATH} at name:`);
  });

  it("names the file for YAML syntax errors", () => {
    expect(() => parseManifest("kind: [agent", PATH)).toThrow(`Invalid Spawnfile manifest ${PATH}:`);
  });

  it("surfaces an inline member's own defect and names the member", () => {
    expect(() => parseManifest([
      'spawnfile_version: "0.1"', "kind: team", "name: studio", "mode: swarm", "members:",
      "  - id: writer",
      "    workspace: { docs: { system: a.md } }",
      "    environment: { mcp_servers: [{ name: tool, transport: stdio, tools: [a] }] }"
    ].join("\n"), "/org/Spawnfile")).toThrow(
      "Invalid Spawnfile manifest for team studio (/org/Spawnfile) member writer at members.0.environment.mcp_servers.0: stdio MCP servers must declare command"
    );
  });

  it("keeps the union message when no member branch is clearly closer", () => {
    expect(() => parseManifest([
      'spawnfile_version: "0.1"', "kind: team", "name: studio", "mode: swarm", "members:", "  - id: writer"
    ].join("\n"), "/org/Spawnfile")).toThrow("member writer at members.0: team member must be either");
  });

  it("resolves nested unions before choosing the closest member branch", () => {
    expect(() => parseManifest([
      'spawnfile_version: "0.1"', "kind: team", "name: studio", "mode: swarm", "members:",
      "  - id: writer",
      "    runtime: { name: 9 }",
      "    workspace: { docs: { system: a.md } }"
    ].join("\n"), "/org/Spawnfile")).toThrow("member writer at members.0.runtime.name:");
  });
});
