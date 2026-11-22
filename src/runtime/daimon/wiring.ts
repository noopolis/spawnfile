import { SpawnfileError } from "../../shared/index.js";
import { DAIMON_SKILL_ROOTS } from "./grokSkillsSupport.js";
import { createMoltnetWorkspace } from "../portableMoltnetWiring.js";
import type { RuntimeWiring } from "../wiringTypes.js";
import { resolveDaimonMemoryWiring } from "./memory.js";

export const DAIMON_CONTROL_TOKEN_ENV = "SPAWNFILE_DAIMON_CONTROL_TOKEN";

export const createMoltnetDaimonReceiptStorePath = (
  networkId: string, memberId: string, networkStateDirectory: string
): string => {
  if (!/^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/u.test(networkId) || networkId.endsWith("-") ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/u.test(memberId) || memberId.endsWith("-")) {
    throw new SpawnfileError("validation_error", "invalid Daimon receipt-store path segment");
  }
  return `${networkStateDirectory}/daimon-receipts/${memberId}.json`;
};

export const daimonWiring: RuntimeWiring = {
  memory: resolveDaimonMemoryWiring,
  moltnet: {
    kind: "daimon",
    releaseCapability: "daimon-bridge",
    actorTokenScopes: ["attach", "observe", "write"],
    // Native tools read the client config and handle chat directly.
    workspace: { ...createMoltnetWorkspace("codex", DAIMON_SKILL_ROOTS), installSkill: false },
    bridge({ agentId, agentName, basePort, memberId, networkId, networkStateDirectory }) {
      if (!basePort) {
        throw new SpawnfileError("compile_error", `Unable to resolve Daimon control port for Moltnet agent ${agentName}`);
      }
      if (!agentId) {
        throw new SpawnfileError("compile_error", `Unable to resolve Daimon runtime agent identity for ${agentName}`);
      }
      return {
        agent_id: agentId,
        control_url: `http://127.0.0.1:${basePort}`,
        kind: "daimon",
        receipt_store_path: createMoltnetDaimonReceiptStorePath(networkId, memberId, networkStateDirectory),
        token_env: DAIMON_CONTROL_TOKEN_ENV
      };
    }
  },
  operatorWakeArtifact: {
    filePath: "app.mjs",
    markers: [
      { text: "/spawnfile/agents/", label: "operator wake route" },
      { text: "SPAWNFILE_PI_CONTROL_TOKEN", label: "SPAWNFILE_PI_CONTROL_TOKEN reference" },
      { text: "no operator token configured (", label: "fail-closed gate" }
    ]
  },
  readiness: { path: "/healthz", exitLabel: "Daimon" }
};
