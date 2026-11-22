import { RuntimeAdapterBase } from "../runtime/adapterBase.js";
import type { RuntimeHostIntegration } from "../runtime/hostTypes.js";
import type { RuntimeOperations } from "../runtime/operations.js";
import { defineRuntimeAdapterPlugin } from "../runtime/pluginDefinition.js";
import { withRuntimeAdapterPlugins } from "../runtime/registry.js";

/** A harmless external adapter, loaded only through the public plugin scope. */
class SyntheticAdapter extends RuntimeAdapterBase {
  readonly container = {
    configFileName: "config.json",
    instancePaths: { configPathTemplate: "<instance-root>/config.json", workspacePathTemplate: "<instance-root>/workspace" },
    standaloneBaseImage: "node:24-bookworm-slim",
    startCommand: ["synthetic-runtime"],
    systemDeps: []
  };

  constructor(
    readonly name: string,
    readonly operations?: RuntimeOperations,
    readonly host?: RuntimeHostIntegration
  ) { super(); }

  async compileAgent() {
    return { capabilities: [], diagnostics: [], files: [] };
  }
}

export const syntheticAdapterPlugin = (
  name: string,
  options: { host?: RuntimeHostIntegration; operations?: RuntimeOperations } = {}
) => defineRuntimeAdapterPlugin({
  apiVersion: 1,
  adapter: new SyntheticAdapter(name, options.operations, options.host),
  catalog: {
    defaultBranch: "main", ref: "v1", remote: "https://example.invalid/synthetic.git",
    install: { kind: "npm", package: "synthetic-runtime", version: "1.0.0" }
  }
});

/** Runs `run` with one synthetic adapter registered for this invocation only. */
export const withSyntheticAdapter = <T>(
  name: string,
  run: () => T | Promise<T>,
  options: { host?: RuntimeHostIntegration; operations?: RuntimeOperations } = {}
): Promise<T> => withRuntimeAdapterPlugins([syntheticAdapterPlugin(name, options)], run);
