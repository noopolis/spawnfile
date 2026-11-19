import {
  createAcpStdioWiring, createMoltnetWorkspace, defineRuntimeAdapterPlugin, RuntimeAdapterBase
} from "spawnfile/adapter";

const harness = "/opt/spawnfile/runtime-installs/echo-harness/harness.mjs";

class EchoAdapter extends RuntimeAdapterBase {
  name = "echo-harness";
  container = {
    configFileName: "agent.json",
    instancePaths: {
      configPathTemplate: "<instance-root>/<config-file>",
      workspacePathTemplate: "<instance-root>/workspace"
    },
    standaloneBaseImage: "node:24-bookworm-slim",
    startCommand: ["node", harness, "serve", "<config-path>"],
    systemDeps: []
  };
  wiring = {
    moltnet: createAcpStdioWiring({
      command: "node",
      args: [harness, "acp"],
      workspace: { ...createMoltnetWorkspace("generic", []), installSkill: false }
    })
  };

  async compileAgent(agent) {
    return {
      capabilities: [], diagnostics: [],
      files: [{ path: this.container.configFileName, content: JSON.stringify({ agent: agent.name }) }]
    };
  }
}

export const spawnfileAdapter = defineRuntimeAdapterPlugin({
  apiVersion: 1,
  adapter: new EchoAdapter(),
  catalog: {
    defaultBranch: "main", ref: "v1.0.0", remote: "https://example.invalid/echo-harness",
    install: { kind: "container_image", image: "spawnfile-fixture/echo-harness", tag: process.env.SPAWNFILE_ACP_FIXTURE_TAG ?? "1.0.0" }
  }
});
