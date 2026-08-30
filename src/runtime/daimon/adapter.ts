import type { EffectiveModelTarget, ResolvedAgentNode, ResolvedAgentSurfaces } from "../../compiler/types.js";
import type { CapabilityReport } from "../../report/index.js";
import { SpawnfileError } from "../../shared/index.js";
import {
  CLI_ENGINE_SKILL_BASE_DIRECTORIES,
  createAgentCapabilities,
  createDiagnostic,
  createDocumentFiles,
  createSkillFiles
} from "../common.js";
import { parseEveryScheduleMs } from "../scheduleUtils.js";
import type { AdapterCompileResult, RuntimeAdapter } from "../types.js";

import {
  createDaimonContainerTargets,
  daimonMemoryCapabilityFor,
  daimonMemorySelectionWarning,
  daimonMemoryVectorRecallWarning,
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

/**
 * The compile-time warning for an agent that asked to be confined to its
 * workspace on a runtime that does not confine anything.
 *
 * `restrict_to_workspace` is accepted by `validateRuntimeOptions` below (it is
 * on the allowlist beside `engine`) and is then read by nothing under
 * `src/runtime/daimon/`: the `noopolis.daimon.organization-runtime.v1` contract
 * this adapter lowers into carries no workspace-confinement field, so the
 * declaration reaches no runtime behavior at all. PicoClaw consumes an
 * identically named option and really does lower it
 * (`../picoclaw/adapter.ts`), which is exactly what makes the option look
 * wired here.
 *
 * This warns rather than implementing confinement, because real workspace
 * restriction for Daimon is a sandbox-profile change in daimon itself plus a
 * widening of the digest-pinned organization runtime contract. It warns rather
 * than rejecting, because an existing project that already declares the option
 * must keep compiling. And it does not stay silent, because a security option
 * that is accepted and ignored is a worse failure than one that is refused.
 *
 * Declaring `restrict_to_workspace: false` asks for nothing, so it says
 * nothing.
 */
const daimonWorkspaceRestrictionWarning = (node: ResolvedAgentNode): string | undefined => {
  const declared = node.runtime.options.restrict_to_workspace;
  if (declared === undefined || declared === false) return undefined;
  return `Daimon organization runtime v1 does not enforce restrict_to_workspace: agent ${node.name} declares `
    + "it, but no Daimon lowering reads the option and the organization runtime contract carries no workspace "
    + "confinement field, so this agent's engine can reach the whole container filesystem. Move the agent to the "
    + "picoclaw runtime, which lowers restrict_to_workspace into its agent defaults, or drop the option and treat "
    + "the container boundary as this agent's only isolation.";
};

/**
 * AGY is no longer excluded here.
 *
 * It used to be: an AGY agent that declared an MCP server or a Moltnet surface
 * was rejected outright, because Daimon pinned AGY to `toolAccess: "none"`.
 * Daimon now mounts AGY on the same per-wake MCP endpoint Codex and Grok get
 * (`daimon/src/pi/cliMcpRegistration.ts`), so an AGY agent can take part in an
 * organization, and the declaration this compiler lowers is one the runtime
 * actually honours. The remaining validations are engine-independent and stay.
 */
const unsupportedAgentFeatures = (node: ResolvedAgentNode): void => {
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
    const memorySelectionWarning = daimonMemorySelectionWarning(node);
    const memoryVectorWarning = daimonMemoryVectorRecallWarning(node);
    const workspaceRestrictionWarning = daimonWorkspaceRestrictionWarning(node);
    return {
      capabilities: createAgentCapabilities(node, {
        mcpOutcome: "supported",
        moltnetMessage: "Daimon exposes one scoped authenticated send tool during real cognition turns",
        moltnetOutcome: "supported",
        ...daimonMemoryCapabilityFor(node),
        scheduleMessage: scheduleCapability.message,
        scheduleOutcome: scheduleCapability.outcome
      }),
      diagnostics: [
        ...(node.execution?.sandbox
          ? [createDiagnostic("warn", "Daimon runtime isolation is enforced by the selected runtime image")]
          : []),
        ...(memorySelectionWarning ? [createDiagnostic("warn", memorySelectionWarning)] : []),
        ...(memoryVectorWarning ? [createDiagnostic("warn", memoryVectorWarning)] : []),
        ...(workspaceRestrictionWarning ? [createDiagnostic("warn", workspaceRestrictionWarning)] : [])
      ],
      files: [
        ...createDocumentFiles("workspace", node.docs),
        ...createSkillFiles(CLI_ENGINE_SKILL_BASE_DIRECTORIES, node.skills)
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
