import { SpawnfileError } from "../../shared/index.js";
import { WORKSPACE_SKILL_BASE_DIRECTORY } from "../common.js";
import { resolveMnemeMcpMemoryWiring } from "../mnemeMcp.js";
import { createMoltnetWorkspace } from "../portableMoltnetWiring.js";
import type { RuntimeWiring } from "../wiringTypes.js";

export const openClawWiring: RuntimeWiring = {
  legacyAgentSkillRoots: ["skills"],
  memory: resolveMnemeMcpMemoryWiring,
  moltnet: {
    kind: "openclaw",
    workspace: createMoltnetWorkspace("openclaw", [WORKSPACE_SKILL_BASE_DIRECTORY]),
    bridge({ agentName, homePath, port }) {
      if (!port) {
        throw new SpawnfileError("compile_error", `Unable to resolve OpenClaw gateway port for Moltnet agent ${agentName}`);
      }
      return {
        gateway_url: `ws://127.0.0.1:${port}`,
        ...(homePath ? { home_path: homePath } : {}),
        kind: "openclaw"
      };
    }
  },
  readiness: { path: "/healthz" }
};
