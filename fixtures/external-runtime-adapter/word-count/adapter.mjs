import { RuntimeAdapterBase, defineRuntimeAdapterPlugin } from "spawnfile/adapter";

class WordCountAdapter extends RuntimeAdapterBase {
  name = "word-count";
  container = {
    configFileName: "input.txt",
    instancePaths: {
      configPathTemplate: "<instance-root>/<config-file>",
      workspacePathTemplate: "<instance-root>/workspace"
    },
    standaloneBaseImage: "node:24-bookworm-slim",
    startCommand: ["node", "<runtime-root>/harness.mjs", "<config-path>", "--watch"],
    systemDeps: []
  };

  async compileAgent(agent) {
    const text = agent.runtime.options.text;
    if (typeof text !== "string") throw new Error("word-count requires runtime.options.text");
    return {
      capabilities: [], diagnostics: [],
      files: [{ path: this.container.configFileName, content: text }]
    };
  }
}

export const spawnfileAdapter = defineRuntimeAdapterPlugin({
  apiVersion: 1,
  adapter: new WordCountAdapter(),
  catalog: {
    defaultBranch: "main", ref: "v1.0.0", remote: "https://example.invalid/word-count",
    install: { kind: "container_image", image: "spawnfile-fixture/word-count", tag: process.env.SPAWNFILE_ACP_FIXTURE_TAG ?? "1.0.0" }
  }
});
