import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Records each module evaluation so tests can check which adapters a command loaded. */
export const adapterModuleSource = (name: string, marker: string): string => `
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`${name}\n`)});
export const spawnfileAdapter = {
  apiVersion: 1,
  adapter: {
    name: ${JSON.stringify(name)},
    assertSupportedModelTarget() {},
    async compileAgent() { return { files: [], capabilities: [], diagnostics: [] }; },
    container: {
      configFileName: "config.json", standaloneBaseImage: "node:24-bookworm-slim",
      startCommand: ["test"], systemDeps: [],
      instancePaths: { configPathTemplate: "/config.json", workspacePathTemplate: "/workspace" }
    },
    install: {
      hints: Object.fromEntries(["container_image", "github_release_archive", "npm", "source_repo"]
        .map(kind => [kind, { ecosystem: "node", installHint: "fixture" }])),
      createRecipe(input) { return { commands: [], copyCommands: [], env: input.containerEnv, runtimeName: input.runtimeName, runtimeRoot: input.installRoot }; }
    }
  },
  catalog: { ref: "v1", remote: "https://example.invalid/plugin", defaultBranch: "main" }
};
`;

export const agentManifest = (name: string, runtime: string, adapters?: Record<string, string>): string => [
  'spawnfile_version: "0.1"',
  "kind: agent",
  `name: ${name}`,
  ...(adapters ? ["adapters:", ...Object.entries(adapters).map(([id, spec]) => `  ${id}: ${JSON.stringify(spec)}`)] : []),
  "runtime:",
  `  name: ${runtime}`,
  "execution:",
  "  model:",
  "    primary:",
  "      provider: local",
  "      name: echo",
  "      endpoint:",
  "        base_url: http://127.0.0.1:9/v1",
  "        compatibility: openai",
  "      auth:",
  "        method: none",
  ""
].join("\n");

export interface AdapterSandbox {
  home: string;
  marker: string;
  root: string;
  evaluated: () => Promise<string[]>;
  project: (relative: string, manifest: string, modules?: Record<string, string>) => Promise<string>;
}

export const createAdapterSandbox = async (): Promise<AdapterSandbox> => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-project-adapters-")));
  const home = path.join(root, "home");
  const marker = path.join(root, "evaluated");
  return {
    evaluated: async () => (await readFile(marker, "utf8").catch(() => "")).split("\n").filter(Boolean),
    home,
    marker,
    project: async (relative, manifest, modules = {}) => {
      const directory = path.join(root, relative);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "Spawnfile"), manifest);
      for (const [file, name] of Object.entries(modules)) {
        await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
        await writeFile(path.join(directory, file), adapterModuleSource(name, marker));
      }
      return directory;
    },
    root
  };
};
