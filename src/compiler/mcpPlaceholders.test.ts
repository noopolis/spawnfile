import { describe, expect, it } from "vitest";

import type { McpServer } from "../manifest/index.js";
import { daimonAdapter } from "../runtime/daimon/adapter.js";
import { openClawAdapter } from "../runtime/openclaw/adapter.js";

import { expandSourceWorkspacePathTemplate } from "./containerTargetResources.js";
import { resolveMcpServerPlaceholders, resolvePlanMcpPlaceholders, type McpPlaceholderContext } from "./mcpPlaceholders.js";
import type { CompilePlanNode } from "./types.js";
import { createPiTestNode } from "../runtime/pi/testHelpers.js";

const context: McpPlaceholderContext = {
  agentId: "agent:writer",
  agentName: "writer",
  workspace: () => "<instance-root>/workspace/agents/writer"
};

const server = (overrides: Partial<McpServer> = {}): McpServer => ({
  command: "/usr/local/bin/node",
  name: "workbench",
  tools: ["read_item"],
  transport: "stdio",
  ...overrides
});

describe("resolveMcpServerPlaceholders", () => {
  it("resolves workspace and agent identity in command, args and env values", () => {
    expect(resolveMcpServerPlaceholders([server({
      args: ["${workspace}/server.mjs", "--as=${agent.name}"],
      command: "${workspace}/bin/node",
      env: { ID: "${agent.id}", ROOT: "${workspace}/state" }
    })], context)).toEqual([server({
      args: ["<instance-root>/workspace/agents/writer/server.mjs", "--as=writer"],
      command: "<instance-root>/workspace/agents/writer/bin/node",
      env: { ID: "agent:writer", ROOT: "<instance-root>/workspace/agents/writer/state" }
    })]);
  });

  it("leaves non-reserved ${...} text and placeholder-free servers untouched", () => {
    let calls = 0;
    const input = server({ env: { TOKEN: "${OTHER_VAR}" } });
    expect(resolveMcpServerPlaceholders([input], { ...context, workspace: () => { calls += 1; return "/w"; } }))
      .toEqual([input]);
    expect(calls).toBe(0);
  });

  it("rejects an unknown agent placeholder, naming the agent and server", () => {
    expect(() => resolveMcpServerPlaceholders([server({ args: ["${agent.home}"] })], context))
      .toThrow("Agent writer MCP server workbench: unknown placeholder ${agent.home}");
  });

  it("rejects placeholders outside command, args and env", () => {
    expect(() => resolveMcpServerPlaceholders([server({
      transport: "streamable_http",
      url: "https://example.test/${agent.name}"
    })], context)).toThrow("only supported in command, args and env values");
  });
});

describe("expandSourceWorkspacePathTemplate", () => {
  it("uses the per-agent workspace of a multi-agent runtime target", () => {
    expect(expandSourceWorkspacePathTemplate(daimonAdapter.container, { agentName: "writer", slug: "writer" }))
      .toBe("<instance-root>/workspace/agents/writer");
  });

  it("falls back to the target workspace for single-agent runtime targets", () => {
    expect(expandSourceWorkspacePathTemplate(openClawAdapter.container, { agentName: "writer", slug: "writer" }))
      .toBe("<workspace-path>");
  });
});

describe("resolvePlanMcpPlaceholders", () => {
  it("uses the node slug and id, not the manifest name, for duplicate-named agents", () => {
    const value = createPiTestNode({
      mcpServers: [server({ args: ["${workspace}/s.mjs"], env: { ID: "${agent.id}", NAME: "${agent.name}" } })],
      name: "writer",
      runtime: { name: "daimon", options: {} }
    });
    const node = { id: "agent:writer#a1b2c3", kind: "agent", runtimeName: "daimon", slug: "writer-a1b2c3", value } as CompilePlanNode;

    resolvePlanMcpPlaceholders([node]);

    expect(value.mcpServers[0]).toMatchObject({
      args: ["<instance-root>/workspace/agents/writer-a1b2c3/s.mjs"],
      env: { ID: "agent:writer#a1b2c3", NAME: "writer" }
    });
  });
});

