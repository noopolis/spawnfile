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
});
