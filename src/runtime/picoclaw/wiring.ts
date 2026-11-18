import { WORKSPACE_SKILL_BASE_DIRECTORY } from "../common.js";
import { resolveMnemeMcpMemoryWiring } from "../mnemeMcp.js";
import { createMoltnetWorkspace } from "../portableMoltnetWiring.js";
import type { RuntimeWiring } from "../wiringTypes.js";

export const picoClawWiring: RuntimeWiring = {
  memory: resolveMnemeMcpMemoryWiring,
  moltnet: {
    kind: "picoclaw",
    statusFields: ["config_path"],
    workspace: createMoltnetWorkspace("picoclaw", [WORKSPACE_SKILL_BASE_DIRECTORY]),
    bridge: ({ configPath, homePath }) => ({
      command: "/usr/local/bin/picoclaw",
      config_path: configPath,
      ...(homePath ? { home_path: homePath } : {}),
      kind: "picoclaw"
    })
  }
};
