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

The base class installs a named npm package at an exact version or copies the runtime root from a container image with a separate tag. An image pin can include a SHA-256 digest. Implement the typed `install` capability for a different artifact layout or install strategy. The adapter emits its native config at `container.configFileName`. Spawnfile expands the path placeholders for each deployed instance.

## Select and load it

Declare external adapter entrypoints once in the root agent or team Spawnfile. Each key matches the name its module exports. Each team member selects its runtime independently. The optional `runtime.options` map becomes `agent.runtime.options` inside the selected adapter.

```yaml
spawnfile_version: "0.1"
kind: team
name: harness-workshop
adapters:
  echo-harness: "@spawnfile-fixtures/echo-adapter"
  word-count: ./word-count/adapter.mjs
mode: swarm
members:
  - id: echo
    runtime: { name: echo-harness }
    workspace: { docs: { system: AGENTS.md } }
  - id: counter
    runtime: { name: word-count, options: { text: "one small custom harness" } }
    workspace: { docs: { system: AGENTS.md } }
```

Install any named package in the project, then review its code and dependencies. From the project directory, run `spawnfile adapters trust .` to approve the declarations for this checkout. Subsequent project commands such as `spawnfile validate .` and `spawnfile compile .` load the declared adapters. A change to the declared name-to-module mapping requires approval again. Plugins run with the operator's permissions. Approval covers the implementation and its dependencies as project code.

Paths beginning with `./` resolve inside the directory containing the root Spawnfile. Bare package names resolve through the project's installed dependencies. The declarations apply throughout the project graph. Keep the map at the root and select adapters by runtime name in child agents. Built-in adapters are always available. The registry rejects duplicate module registrations and attempts to replace an active built-in.

For ad hoc modules or an image without a source project, pass `--adapter ./adapter.mjs` or `--adapter @example/adapter`. The repeatable flag resolves from the invocation's working directory. An explicit module takes precedence for its runtime name. Every remaining project-declared module still requires approval. Image startup and release need the adapter's launch settings. Artifact export, including `down --export-to`, needs its file list. A missing adapter stops the operation. An adapter with no export hook can legitimately contribute zero runtime files. A required file that fails to copy makes export exit with an error and leaves the deployment eligible for a retry. Direct JSON export includes the missing required files in `failed_files`.

Programmatic callers can load a trusted Spawnfile's declarations with `loadProjectRuntimeAdapterPlugins(projectPath)`, or pass explicit module names to `loadRuntimeAdapterPlugins(specifiers, { cwd })`. Pass the result and a callback to `withRuntimeAdapterPlugins(plugins, callback)`. Registration lasts for the callback and its asynchronous work. The integration test compiles Echo and Word Count in one project, then runs Word Count on its generated input. [Test Spawnfile](../fixtures/external-runtime-adapter/Spawnfile) and [complete local adapter](../fixtures/external-runtime-adapter/word-count/adapter.mjs).

Packages that imported implementation files directly from `spawnfile/dist/` may need to migrate when native files move into their adapter folders. Import adapter contracts from `spawnfile/adapter`. Training integrations can obtain the composed providers with `await trainingDependencies()` from `spawnfile/training/cli`. [Training integration entry points](TRAINING.md#interim-public-integration-entry-points)

## Optional features

Declare the features the harness actually supports. A memory hook, credential preparation, health check, training provider, or Moltnet connection can be supplied independently. Native code, schemas, install assets, credentials, and compatibility readers belong to the adapter folder.

An adapter that consumes raw imported CLI credentials lists the supported methods in `container.rawHomeAuthImports`. Spawnfile mounts a configured profile import into an instance's home only when that instance also requests the matching model authentication method. For example, an instance that selects only Codex gets only the `.codex` mount, even when the profile contains both logins. Earlier versions also mounted `.claude` in that home. A secondary CLI that relied on that implicit login now needs its own declared credential setup. External runtimes sharing a container must all opt into each raw credential staged there. Adapters can also implement host authentication hooks to manage credentials themselves.

Use relative paths under the compiled runtime directory for the Moltnet workspace, client config and installed skill files. A memory hook's volume target must be a canonical absolute container directory. The operator may select an output folder through a directory symlink. Path checks apply inside the resolved folder.

Runtime export hooks return canonical relative paths. Each file and private directory must have a distinct destination. Spawnfile reserves its export index, lock and temporary staging area. A failed required copy keeps the preceding export and deployment record intact.

For an ACP agent, use `createAcpStdioWiring({ command, args, workspace })` for `wiring.moltnet`. Moltnet starts that executable in the agent workspace. Arguments retain their boundaries. The adapter should use the emitted client config when its agent explicitly sends a reply. The fixture demonstrates this with a local Node process. Emitting the ACP protocol requires a verified Moltnet release advertising `acp-bridge`, including for handwritten wiring. An adapter can declare additional requirements with `releaseCapability`. The bundled v0.1.19 pin advertises the earlier bridges. The local-development build can verify an ACP-capable Moltnet archive. [Runtime registry](RUNTIMES.md)

## Run the custom harness tests

To try the two-harness case from a fresh Spawnfile checkout with Node 22.19 or newer, run the source CLI regression. It creates a temporary consumer, approves its adapter map, compiles the team and checks Word Count's output.

```bash
npm ci
node --experimental-strip-types --test scripts/verify-external-adapter.test.ts
```

Use a clean Moltnet checkout that supports ACP and a local Docker daemon.
Run from the Spawnfile checkout with its dependencies installed.

```bash
release_dir="$(mktemp -d)"
SPAWNFILE_MOLTNET_SOURCE_DIR=/absolute/path/to/moltnet \
  SPAWNFILE_MOLTNET_ENABLE_ACP=1 \
  SPAWNFILE_MOLTNET_LOCAL_RELEASE_OUTPUT="$release_dir" npm run build:local-moltnet
SPAWNFILE_VERIFY_ACP_RELEASE_DIR="$release_dir" npm run verify:package-closure
```

The check installs both tarballs into a temporary consumer, builds a separate
image for each harness, and verifies both start and Echo answers room and direct messages on a
published loopback port. It restarts the container, checks both old reply IDs
and new replies, and removes its containers, tags, and named volumes. The
opt-in release must match the daemon architecture. Without the opt-in, the
closure check keeps using the normal published pin.
