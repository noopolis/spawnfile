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
import { resolveDaimonGrokModel } from "./grokModel.js";
import { prepareDaimonRuntimeAuth } from "./runAuth.js";
import { hasDaimonScheduleAuthority } from "./scheduleAuthority.js";
import { resolveDaimonAttention } from "./attention.js";

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
  if (target.provider === "openai" && target.auth.method === "codex" && !target.endpoint && !target.reasoningEffort) return;
  if (target.provider === "xai" && target.auth.method === "grok" && !target.endpoint) return;
  throw new SpawnfileError(
    "validation_error",
    "Daimon organization runtime v1 accepts only the optional OpenAI Codex subscription intent or a brokered xAI Grok declaration; AGY engine auth stays Daimon-owned"
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
 * Workspace skill roots per Daimon engine.
 *
 * Codex and AGY keep both CLI-engine roots. A brokered Grok worker loads no
 * workspace skill at all: Grok 1.0.34 discovers `.agents/skills` (never
 * `.codex/skills`) only in a trusted folder, and Daimon keeps the workspace
 * untrusted (root-owned empty `trusted_folders.toml`) and replaces the system
 * prompt, whose fixed text references no skill. Emitting either root would ship
 * files nothing reads, so none are emitted and the declaration is reported.
 */
export const daimonSkillBaseDirectories = (node: ResolvedAgentNode): readonly string[] =>
  resolveDaimonEngine(node) === "grok" ? [] : CLI_ENGINE_SKILL_BASE_DIRECTORIES;

const daimonGrokSkillWarning = (node: ResolvedAgentNode): string | undefined => {
  if (resolveDaimonEngine(node) !== "grok" || node.skills.length === 0) return undefined;
  return `Daimon Grok agent ${node.name} declares workspace skills (${node.skills.map((skill) => skill.name).sort().join(", ")}) `
    + "that its brokered worker never loads: Grok discovers project skills only in a trusted workspace, and Daimon keeps the "
    + "workspace untrusted and supplies instructions through the prompt. No skill files are emitted; move the guidance into the agent's docs.";
};

const daimonCodexPolicyError = (node: ResolvedAgentNode): string | undefined => {
  if (node.runtime.options.codex_policy === undefined) return undefined;
  if (node.runtime.options.codex_policy !== "workspace-no-network") {
    return "Daimon runtime option codex_policy must be workspace-no-network";
  }
  if (resolveDaimonEngine(node) !== "codex") {
    return "Daimon runtime option codex_policy=workspace-no-network is only supported for Codex agents";
  }
  if (node.execution?.sandbox?.mode !== "workspace") {
    return "Daimon runtime option codex_policy=workspace-no-network requires execution.sandbox.mode: workspace";
  }
  return undefined;
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
  const engine = resolveDaimonEngine(node);
  if (engine === "agy" && node.execution?.model) {
    throw new SpawnfileError(
      "validation_error",
      "Daimon AGY agents must omit Spawnfile execution.model; their subscription auth and model selection are Daimon-owned"
    );
  }
  if (engine === "codex" && node.execution?.model?.primary.auth?.method === "grok") {
    throw new SpawnfileError("validation_error", `Daimon Codex agent ${node.name} cannot declare Grok model auth`);
  }
  if (engine === "grok") resolveDaimonGrokModel(node);
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
    const codexPolicyError = daimonCodexPolicyError(node);
    const grokSkillWarning = daimonGrokSkillWarning(node);
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
        ...(workspaceRestrictionWarning ? [createDiagnostic("warn", workspaceRestrictionWarning)] : []),
        ...(grokSkillWarning ? [createDiagnostic("warn", grokSkillWarning)] : []),
        ...(codexPolicyError ? [createDiagnostic("error", codexPolicyError)] : [])
      ],
      files: [
        ...createDocumentFiles("workspace", node.docs),
        ...createSkillFiles(daimonSkillBaseDirectories(node), node.skills)
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
    for (const key of Object.keys(options).filter((key) => !["engine", "restrict_to_workspace", "codex_policy", "attention"].includes(key))) {
      diagnostics.push(createDiagnostic("error", `Daimon runtime option ${key} is not part of organization runtime v1`));
    }
    if (options.codex_policy !== undefined && options.codex_policy !== "workspace-no-network") {
      diagnostics.push(createDiagnostic("error", "Daimon runtime option codex_policy must be workspace-no-network"));
    }
    if (options.codex_policy === "workspace-no-network" && options.engine !== undefined && options.engine !== "codex") {
      diagnostics.push(createDiagnostic("error", "Daimon runtime option codex_policy=workspace-no-network is only supported for Codex agents"));
    }
    try { resolveDaimonAttention(options.attention); }
    catch (error) { diagnostics.push(createDiagnostic("error", error instanceof Error ? error.message : "Daimon attention is invalid")); }
    return diagnostics;
  }
};
