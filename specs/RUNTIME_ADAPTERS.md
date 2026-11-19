# Writing a runtime adapter

A runtime adapter translates a resolved Spawnfile agent into native files and describes how the container starts. All bundled adapters implement the same versioned interface as an external adapter. Spawnfile still owns the organization, mounts, lifecycle, and release checks.

## Implement an adapter

An ESM package exports a named `spawnfileAdapter` value. Import public types and helpers from `spawnfile/adapter`, and declare Spawnfile as a peer dependency. TypeScript authors can extend `RuntimeAdapterBase`. The three required members are the runtime name, container settings, and native config writer. A plain typed `RuntimeAdapter` implementation can also provide its own model validation and install capability.

Here is a complete adapter module for an example harness distributed in an image. The image contains the executable under `/opt/spawnfile/runtime-installs/echo-harness/`.

```ts
import {
  RuntimeAdapterBase, defineRuntimeAdapterPlugin,
  type AdapterCompileResult, type ResolvedAgentNode, type RuntimeContainerMeta
} from "spawnfile/adapter";

class EchoAdapter extends RuntimeAdapterBase {
  readonly name = "echo-harness";
  readonly container: RuntimeContainerMeta = {
    configFileName: "agent.json",
    instancePaths: {
      configPathTemplate: "<instance-root>/<config-file>",
      workspacePathTemplate: "<instance-root>/workspace"
    },
    standaloneBaseImage: "node:24-bookworm-slim",
    startCommand: ["node", "<runtime-root>/harness.mjs", "serve", "<config-path>"],
    systemDeps: []
  };

  async compileAgent(agent: ResolvedAgentNode): Promise<AdapterCompileResult> {
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
    install: { kind: "container_image", image: "spawnfile-fixture/echo-harness", tag: "1.0.0" }
  }
});
```

The base class installs a pinned npm package or copies the runtime root from a container image. An image pin can include a SHA-256 digest. Implement the typed `install` capability for a different artifact layout or install strategy. The adapter emits its native config at `container.configFileName`. Spawnfile expands the path placeholders for each deployed instance.

## Select and load it

An agent selects `runtime: { name: echo-harness }` in its Spawnfile. Its optional `runtime.options` become `agent.runtime.options`. The operator installs a trusted package and passes its name to commands that use it, for example `spawnfile --adapter @spawnfile-fixtures/echo-adapter compile .`. A local module works the same way with `--adapter ./adapter.mjs`. The flag is repeatable and resolves from the invocation's working directory.

Loading a plugin executes its module with the operator's local permissions. The runtime name in a Spawnfile only selects a registered adapter. Installing an adapter and loading it are explicit operator actions. Built-ins remain available automatically. Duplicate registrations and attempts to replace an active built-in fail. An external package can supply an implementation for a catalog-only exploratory name.

For programmatic callers, load the explicit module specifiers with `loadRuntimeAdapterPlugins(specifiers, { cwd })`. Pass that result and a callback to `withRuntimeAdapterPlugins(plugins, callback)`. The registration lasts for the callback and its asynchronous work. A new scope selects its own plugins. The package closure check exercises the installed CLI with both a local file and a separately packed adapter. [Runnable example package](../fixtures/external-runtime-adapter)

## Optional features

Declare the features the harness actually supports. A memory hook, credential preparation, health check, training provider, or Moltnet connection can be supplied independently. Native code, schemas, install assets, credentials, and compatibility readers belong to the adapter folder.

For an ACP agent, use `createAcpStdioWiring({ command, args, workspace })` for `wiring.moltnet`. Moltnet starts that executable in the agent workspace. Arguments retain their boundaries. The adapter should use the emitted client config when its agent explicitly sends a reply. The fixture demonstrates this with a local Node process. ACP messaging requires a verified Moltnet release advertising `acp-bridge`. The bundled v0.1.19 pin advertises the earlier bridges. The local-development build can verify an ACP-capable Moltnet archive. [Runtime registry](RUNTIMES.md)
