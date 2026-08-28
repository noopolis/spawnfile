import type { EffectiveModelTarget, ResolvedAgentNode, ResolvedAgentSurfaces } from "../../compiler/types.js";
import type { CapabilityReport } from "../../report/index.js";
import { SpawnfileError } from "../../shared/index.js";
import { createAgentCapabilities, createDiagnostic, createDocumentFiles, createSkillFiles } from "../common.js";
import { parseEveryScheduleMs } from "../scheduleUtils.js";
import type { AdapterCompileResult, RuntimeAdapter } from "../types.js";

import {
  createDaimonContainerTargets,
  DAIMON_CONFIG_FILE,
  DAIMON_CONTROL_PORT,
  DAIMON_ENGINES,
  resolveDaimonEngine
} from "./config.js";
import { prepareDaimonRuntimeAuth } from "./runAuth.js";
import { hasDaimonScheduleAuthority } from "./scheduleAuthority.js";

const assertDaimonSurfaces = (surfaces: ResolvedAgentSurfaces | undefined): void => {
  if (!surfaces) return;
  const enabled = Object.entries(surfaces)
    .filter(([name]) => name !== "moltnet")
    .filter(([, value]) => Array.isArray(value) ? value.length > 0 : value !== undefined)
    .map(([name]) => name);
  if (enabled.length > 0) {
    throw new SpawnfileError(
      "validation_error",
      `Daimon organization runtime v1 only lowers Moltnet agent surfaces; remove: ${enabled.sort().join(", ")}`
    );
  }
};

const assertDaimonModel = (target: EffectiveModelTarget): void => {
  if (target.provider === "openai" && target.auth.method === "codex" && !target.endpoint) return;
  throw new SpawnfileError(
    "validation_error",
    "Daimon organization runtime v1 accepts only the optional OpenAI Codex subscription intent; Grok and AGY engine auth stays Daimon-owned"
  );
};

const unsupportedAgentFeatures = (node: ResolvedAgentNode): void => {
  if (resolveDaimonEngine(node) === "agy" && (node.mcpServers.length > 0 || (node.surfaces?.moltnet?.length ?? 0) > 0)) throw new SpawnfileError("validation_error", "Daimon AGY does not expose cognition tools; use Codex or Grok for declared MCP or Moltnet actions");
  for (const server of node.mcpServers) {
    if (!server.tools?.length) throw new SpawnfileError("validation_error", `Daimon MCP server ${server.name} requires an explicit tools allowlist`);
    if (server.transport === "stdio" && !server.command?.startsWith("/")) throw new SpawnfileError("validation_error", `Daimon stdio MCP server ${server.name} requires an absolute command`);
  }
  if (resolveDaimonEngine(node) !== "codex" && node.execution?.model) {
    throw new SpawnfileError(
      "validation_error",
      "Daimon Grok and AGY agents must omit Spawnfile execution.model; their subscription auth and model selection are Daimon-owned"
    );
  }
};

const scheduleCapabilityFor = async (
  node: ResolvedAgentNode
): Promise<{ message?: string; outcome?: CapabilityReport["outcome"] }> => {
  if (!node.schedule) return {};
  let authoritative = false;
  try { authoritative = await hasDaimonScheduleAuthority(); } catch { /* The lowering gate reports invalid receipt details. */ }
  if (!authoritative) {
    return {
      message: "Daimon v2 schedule state: degraded; the selected image receipt does not attest v2, so no schedule lowering is emitted",
      outcome: "degraded"
    };
  }
  if (node.schedule.kind === "disabled") {
    return {
      message: "Daimon v2 schedule state: disabled; normalized=disabled; persistence=none; timer=stopped",
      outcome: "supported"
    };
  }
  const normalized = node.schedule.kind === "every"
    ? `every/${parseEveryScheduleMs(node.schedule.every)}ms`
    : `cron/${node.schedule.cron.trim().replace(/\s+/gu, " ")}; zone=${node.schedule.timezone ?? "UTC"}`;
  return {
    message: `Daimon v2 schedule state: supported; normalized=${normalized}; persistence=sha256(agent+schedule) in durable acceptance root; timer=runtime-managed`,
    outcome: "supported"
  };
};

export const daimonAdapter: RuntimeAdapter = {
  assertSupportedModelTarget: assertDaimonModel,
  assertSupportedSurfaces: assertDaimonSurfaces,
  container: {
    configFileName: DAIMON_CONFIG_FILE,
    configPathEnv: "SPAWNFILE_DAIMON_CONFIG",
    env: [{
      description: "Bearer token for the Daimon organization control API",
      generated: true,
      name: "SPAWNFILE_DAIMON_CONTROL_TOKEN",
      required: true
    }],
    instancePaths: {
      configPathTemplate: "<instance-root>/daimon/<config-file>",
      sourceWorkspacePathTemplate: "<instance-root>/workspace/agents/<source-slug>",
      workspacePathTemplate: "<instance-root>/workspace"
    },
    port: DAIMON_CONTROL_PORT,
    portEnv: "SPAWNFILE_DAIMON_CONTROL_PORT",
    standaloneBaseImage: "node:24-bookworm-slim",
    startCommand: ["bash", "<runtime-root>/daimon-start.sh"],
    systemDeps: [
      "bash",
      "bubblewrap",
      "ca-certificates",
      "curl",
      "dbus-daemon",
      "gnome-keyring",
      "util-linux"
    ]
  },
  async compileAgent(node): Promise<AdapterCompileResult> {
    unsupportedAgentFeatures(node);
    const scheduleCapability = await scheduleCapabilityFor(node);
    return {
      capabilities: createAgentCapabilities(node, {
        mcpOutcome: "supported",
        moltnetMessage: "Daimon exposes one scoped authenticated send tool during real cognition turns",
        moltnetOutcome: "supported",
        memoryMessage: "Daimon organization runtime v1 does not lower Spawnfile memory declarations yet",
        memoryOutcome: "degraded",
        scheduleMessage: scheduleCapability.message,
        scheduleOutcome: scheduleCapability.outcome
      }),
      diagnostics: node.execution?.sandbox
        ? [createDiagnostic("warn", "Daimon runtime isolation is enforced by the selected runtime image")]
        : [],
      files: [
        ...createDocumentFiles("workspace", node.docs),
        ...createSkillFiles("workspace/skills", node.skills)
      ]
    };
  },
  createContainerTargets: createDaimonContainerTargets,
  name: "daimon",
  prepareRuntimeAuth: prepareDaimonRuntimeAuth,
  systemInstructionSurface: {
    placement: "append_pointer",
    resolvePath() {
      return "workspace/AGENTS.md";
    }
  },
  validateRuntimeOptions(options) {
    const diagnostics = [];
    if (options.engine !== undefined &&
      (typeof options.engine !== "string" || !(DAIMON_ENGINES as readonly string[]).includes(options.engine))) {
      diagnostics.push(createDiagnostic("error", `Daimon runtime option engine must be one of ${DAIMON_ENGINES.join(", ")}`));
    }
    for (const key of Object.keys(options).filter((key) => key !== "engine" && key !== "restrict_to_workspace")) {
      diagnostics.push(createDiagnostic("error", `Daimon runtime option ${key} is not part of organization runtime v1`));
    }
    return diagnostics;
  }
};
