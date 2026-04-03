import { describe, expect, it } from "vitest";

import {
  createTeamMcpServerEntry,
  generateTeamMcpScript,
  generateTeamMessageCliScript
} from "./teamMcp.js";

describe("generateTeamMcpScript", () => {
  it("returns a non-empty string containing team_message", () => {
    const script = generateTeamMcpScript();
    expect(script.length).toBeGreaterThan(0);
    expect(script).toContain("team_message");
  });

  it("returns syntactically valid JavaScript", () => {
    const script = generateTeamMcpScript();
    // new Function compiles the script body without executing it.
    // Top-level await is not used in the generated script, so this works.
    expect(() => new Function(script)).not.toThrow();
  });

  it("contains MCP protocol handlers for initialize", () => {
    const script = generateTeamMcpScript();
    expect(script).toContain("initialize");
    expect(script).toContain("handleInitialize");
  });

  it("contains MCP protocol handlers for tools/list", () => {
    const script = generateTeamMcpScript();
    expect(script).toContain("tools/list");
    expect(script).toContain("handleToolsList");
  });

  it("contains MCP protocol handlers for tools/call", () => {
    const script = generateTeamMcpScript();
    expect(script).toContain("tools/call");
    expect(script).toContain("handleToolsCall");
  });

  it("contains handler for notifications/initialized", () => {
    const script = generateTeamMcpScript();
    expect(script).toContain("notifications/initialized");
  });

  it("reads environment variables for router URL, agent name, and team secret", () => {
    const script = generateTeamMcpScript();
    expect(script).toContain("SPAWNFILE_ROUTER_URL");
    expect(script).toContain("SPAWNFILE_AGENT_NAME");
    expect(script).toContain("SPAWNFILE_TEAM_SECRET");
  });

  it("posts to the /team/message endpoint", () => {
    const script = generateTeamMcpScript();
    expect(script).toContain("/team/message");
  });
});

describe("generateTeamMessageCliScript", () => {
  it("returns a non-empty string containing team config discovery", () => {
    const script = generateTeamMessageCliScript();
    expect(script.length).toBeGreaterThan(0);
    expect(script).toContain(".spawnfile/team.json");
    expect(script).toContain("SPAWNFILE_TEAM_CONFIG");
  });

  it("requires explicit to/message flags", () => {
    const script = generateTeamMessageCliScript();
    expect(script).toContain("--to");
    expect(script).toContain("--message");
  });

  it("posts to the /team/message endpoint", () => {
    const script = generateTeamMessageCliScript();
    expect(script).toContain("/team/message");
  });

  it("returns syntactically valid JavaScript", () => {
    const script = generateTeamMessageCliScript();
    const normalized = script.replace(/^#![^\n]*\n/, "");
    expect(() => new Function(normalized)).not.toThrow();
  });
});

describe("createTeamMcpServerEntry", () => {
  it("returns a valid MCP server config with stdio transport", () => {
    const entry = createTeamMcpServerEntry("/home/agent");
    expect(entry.transport).toBe("stdio");
  });

  it("uses node as the command", () => {
    const entry = createTeamMcpServerEntry("/home/agent");
    expect(entry.command).toBe("node");
  });

  it("points args to the .spawnfile/team-mcp.js path under instance root", () => {
    const entry = createTeamMcpServerEntry("/home/agent");
    expect(entry.args).toEqual(["/home/agent/.spawnfile/team-mcp.js"]);
  });

  it("sets the server name to spawnfile_team", () => {
    const entry = createTeamMcpServerEntry("/home/agent");
    expect(entry.name).toBe("spawnfile_team");
  });

  it("uses the provided instance root in the path", () => {
    const entry = createTeamMcpServerEntry("/var/run/instance-42");
    expect(entry.args).toEqual(["/var/run/instance-42/.spawnfile/team-mcp.js"]);
  });
});
