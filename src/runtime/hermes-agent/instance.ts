import { resolveMnemeMcpMemoryWiring } from "../mnemeMcp.js";
import { posix } from "node:path";
import { SpawnfileError } from "../../shared/index.js";
import { createAcpStdioWiring, createMoltnetWorkspace } from "../portableMoltnetWiring.js";
import type { RuntimeMoltnetBridgeContext } from "../wiringTypes.js";
import { hermesConfigFile } from "./config.js";
import { hermesBinary } from "./install.js";

export const hermesEnvCommand = [
  "env", "-u", "HERMES_TUI_GATEWAY_URL", "-u", "HERMES_YOLO_MODE", "-u", "HERMES_IGNORE_RULES",
  "-u", "HERMES_SAFE_MODE", "-u", "HERMES_IGNORE_USER_CONFIG", "-u", "HERMES_ACCEPT_HOOKS",
  "-u", "HERMES_MODEL", "-u", "HERMES_INFERENCE_PROVIDER", "-u", "HERMES_PROFILE",
  "-u", "HERMES_CODEX_BASE_URL", "-u", "HERMES_XAI_BASE_URL", "-u", "XAI_BASE_URL",
  "-u", "OPENAI_BASE_URL", "-u", "OPENAI_API_KEY", "-u", "XAI_API_KEY",
  "-u", "ANTHROPIC_BASE_URL", "-u", "ANTHROPIC_AUTH_TOKEN", "-u", "ANTHROPIC_API_KEY",
  "-u", "CLAUDE_CODE_OAUTH_TOKEN", "-u", "OPENROUTER_API_KEY", "-u", "SPAWNFILE_CLI_AUTH_JSON"
];

export function hermesEnvironment(homePath: string, workspacePath: string): Record<string, string> {
  return {
    HOME: homePath,
    HERMES_HOME: homePath,
    CODEX_HOME: posix.join(homePath, ".codex"),
    XDG_CONFIG_HOME: posix.join(homePath, ".config"),
    XDG_DATA_HOME: posix.join(homePath, ".local", "share"),
    XDG_CACHE_HOME: posix.join(homePath, ".cache"),
    HERMES_RUNTIME_DIR: "/opt/hermes/tools",
    HERMES_WRITE_SAFE_ROOT: workspacePath,
    XDG_RUNTIME_DIR: homePath
  };
}

function acpArgs(context: RuntimeMoltnetBridgeContext): string[] {
  const { configPath, homePath } = context;
  if (!homePath || configPath !== posix.join(homePath, hermesConfigFile)) {
    throw new SpawnfileError("validation_error", `Hermes Agent config is outside the native home for ${context.agentName}`);
  }
  return [
    ...hermesEnvCommand.slice(1),
    ...Object.entries(hermesEnvironment(homePath, context.workspacePath)).map(([name, value]) => `${name}=${value}`),
    hermesBinary, "acp"
  ];
}

export const hermesWiring = {
  memory: resolveMnemeMcpMemoryWiring,
  legacyAgentSkillRoots: ["skills", ".agents/skills"],
  moltnet: {
    ...createAcpStdioWiring({
      command: "env",
      args: acpArgs,
      workspace: createMoltnetWorkspace("generic", ["workspace/.agents/skills"])
    }),
    actorTokenScopes: ["attach", "observe", "write"]
  }
};
