import { SpawnfileError } from "../shared/index.js";
import type {
  RuntimeMoltnetBridgeContext,
  RuntimeMoltnetWiring,
  RuntimeMoltnetWorkspace
} from "./wiringTypes.js";

/** Build relative client and skill paths in the adapter's emitted workspace. */
export const createMoltnetWorkspace = (
  cliRuntime: string,
  skillRoots: readonly string[],
  workspaceRootPath = "workspace"
): RuntimeMoltnetWorkspace => ({
  clientConfigPath: `${workspaceRootPath}/.moltnet/config.json`,
  cliRuntime,
  skillPaths: skillRoots.map((root) => `${root}/moltnet/SKILL.md`),
  workspaceRootPath
});

export interface AcpStdioWiringOptions {
  command: string;
  args?: readonly string[] | ((context: RuntimeMoltnetBridgeContext) => readonly string[]);
  workspacePath?: string | ((context: RuntimeMoltnetBridgeContext) => string);
  workspace: RuntimeMoltnetWorkspace;
}

/**
 * ACP launches a subprocess directly. Arguments are preserved as individual
 * values in Moltnet JSON, including spaces, with no shell interpolation.
 */
export const createAcpStdioWiring = (options: AcpStdioWiringOptions): RuntimeMoltnetWiring => ({
  kind: "acp",
  releaseCapability: "acp-bridge",
  workspace: options.workspace,
  statusFields: ["command", "workspace_path"],
  bridge(context) {
    const { command, workspacePath } = options;
    const args = typeof options.args === "function" ? options.args(context) : options.args;
    const workspace = typeof workspacePath === "function"
      ? workspacePath(context)
      : workspacePath ?? context.workspacePath;
    if (!command.trim() || command.includes("\0") ||
      !workspace.trim() || workspace.includes("\0") ||
      args?.some((argument) => argument.includes("\0"))) {
      throw new SpawnfileError("validation_error", `Invalid ACP stdio wiring for agent ${context.agentName}`);
    }
    return { kind: "acp", command, ...(args ? { args: [...args] } : {}), workspace_path: workspace };
  }
});
