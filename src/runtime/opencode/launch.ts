import { resolveMnemeMcpMemoryWiring, MNEME_PACKAGE } from "../mnemeMcp.js";
import { posix } from "node:path";

import { standardRuntimeInstall } from "../adapterBase.js";
import type { RuntimeInstallCapability } from "../containerRecipe.js";
import { SpawnfileError } from "../../shared/index.js";
import { createAcpStdioWiring, createMoltnetWorkspace } from "../portableMoltnetWiring.js";
import type { RuntimeContainerMeta } from "../types.js";
import type { RuntimeWiring } from "../wiringTypes.js";
import { opencodeSubscriptionMethods } from "./auth.js";
import { opencodeLaunchFile, opencodeSessionsDirectory } from "./launchScript.js";

export const opencodeConfigFile = "opencode.json";
export const opencodeBinary = "/usr/local/bin/opencode";
const moltnetSkillRoot = ".agents/skills";
export const opencodeSkillRoots = ["skills", moltnetSkillRoot] as const;

// npm 12 can leave the package's launcher stub in place on a custom Node base.
export const openCodeInstall: RuntimeInstallCapability = {
  hints: standardRuntimeInstall.hints,
  async createRecipe(input) {
    if (input.selection.kind !== "npm" || input.selection.packageName !== "opencode-ai") {
      throw new SpawnfileError("runtime_error", "OpenCode requires the pinned opencode-ai npm package");
    }
    const recipe = await standardRuntimeInstall.createRecipe(input);
    return { ...recipe, commands: [...recipe.commands, `node ${recipe.runtimeRoot}/postinstall.mjs`] };
  }
};

export function opencodeEnvironment(configPath: string, homePath: string, workspacePath: string) {
  return {
    HOME: homePath,
    PWD: workspacePath,
    XDG_CACHE_HOME: posix.join(homePath, ".cache"),
    XDG_CONFIG_HOME: posix.join(homePath, ".config"),
    XDG_DATA_HOME: posix.join(homePath, ".local/share"),
    XDG_STATE_HOME: posix.join(homePath, ".local/state"),
    OPENCODE_CONFIG: configPath,
    OPENCODE_DB: posix.join(homePath, opencodeSessionsDirectory, "opencode.db"),
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "true"
  };
}

function launchArgs(configPath: string, homePath: string, workspacePath: string): string[] {
  return [
    ...Object.entries(opencodeEnvironment(configPath, homePath, workspacePath)).map(([key, value]) => `${key}=${value}`),
    ...opencodeLaunchCommand(homePath)
  ];
}

export function opencodeLaunchCommand(homePath: string): string[] {
  return ["/bin/bash", posix.join(homePath, opencodeLaunchFile), opencodeBinary];
}

export const opencodeContainer: RuntimeContainerMeta = {
  adapterManagedAuthMethods: Object.values(opencodeSubscriptionMethods),
  configFileName: opencodeConfigFile,
  globalNpmPackages: [MNEME_PACKAGE],
  configPathEnv: "OPENCODE_CONFIG",
  instancePaths: {
    configPathTemplate: "<instance-root>/<config-file>",
    homePathTemplate: "<instance-root>/home",
    workspacePathTemplate: "<instance-root>/workspace"
  },
  port: 4096,
  standaloneBaseImage: "node:24-bookworm-slim",
  startCommand: [
    "/usr/bin/env", "-C", "<workspace-path>",
    ...launchArgs("<config-path>", "<home-path>", "<workspace-path>"),
    "serve", "--hostname", "127.0.0.1", "--port", "<port>"
  ],
  systemDeps: ["bash", "ca-certificates", "curl", "git", "util-linux"]
};

export const opencodeWiring: RuntimeWiring = {
  memory: resolveMnemeMcpMemoryWiring,
  legacyAgentSkillRoots: opencodeSkillRoots,
  moltnet: {
    ...createAcpStdioWiring({
      command: "/usr/bin/env",
      sessionStorePath({ homePath, networkId, agentName }) {
        if (!homePath) throw new SpawnfileError("validation_error", `OpenCode ACP requires an instance home for ${agentName}`);
        return posix.join(homePath, opencodeSessionsDirectory, `moltnet-${encodeURIComponent(networkId)}.json`);
      },
      args({ agentName, configPath, homePath, workspacePath }) {
        if (!homePath) {
          throw new SpawnfileError("validation_error", `OpenCode ACP requires an instance home for ${agentName}`);
        }
        return ["-C", workspacePath, ...launchArgs(configPath, homePath, workspacePath), "acp", "--hostname", "127.0.0.1", "--port", "0", "--cwd", workspacePath];
      },
      workspace: createMoltnetWorkspace("generic", [`workspace/${moltnetSkillRoot}`])
    }),
    actorTokenScopes: ["attach", "observe", "write"]
  },
  readiness: { path: "/global/health", exitLabel: "OpenCode" }
};
