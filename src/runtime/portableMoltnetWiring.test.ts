import { describe, expect, it } from "vitest";

import { createAcpStdioWiring, createMoltnetWorkspace } from "./portableMoltnetWiring.js";
import type { RuntimeMoltnetBridgeContext } from "./wiringTypes.js";

const context = (agent: string): RuntimeMoltnetBridgeContext => ({
  agentId: agent, agentName: agent, memberId: agent, nodeSlug: agent,
  configPath: `/agents/${agent}/config.json`, homePath: `/agents/${agent}`,
  networkId: "room", networkStateDirectory: "/state", workspacePath: `/agents/${agent}/workspace`
});
const workspace = createMoltnetWorkspace("generic", ["workspace/.agents/skills"]);

describe("ACP launch arguments", () => {
  it("passes each agent's own config and home as literal arguments", () => {
    const wiring = createAcpStdioWiring({
      command: "env", workspace,
      args: ({ homePath, configPath }) => [`HOME=${homePath}`, "example-cli", "--config", configPath, "acp"]
    });
    for (const agent of ["First agent", "Second $(literal)"]) {
      const instance = context(agent);
      expect(wiring.bridge(instance)).toEqual({
        kind: "acp", command: "env", workspace_path: instance.workspacePath,
        args: [`HOME=/agents/${agent}`, "example-cli", "--config", instance.configPath, "acp"]
      });
    }
  });

  it("checks resolved arguments before emitting them", () => {
    const wiring = createAcpStdioWiring({ command: "example-cli", workspace, args: ctx => [ctx.configPath] });
    expect(() => wiring.bridge({ ...context("one"), configPath: "bad\0path" })).toThrow("Invalid ACP stdio wiring");
  });
});
