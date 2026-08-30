import { randomUUID } from "node:crypto";

import type { ResolvedAgentNode, ResolvedDocument, ResolvedSkill } from "../compiler/types.js";
import type { CapabilityReport, DiagnosticReport } from "../report/index.js";

import { EmittedFile } from "./types.js";

const ROLE_FILE_NAMES: Record<string, string> = {
  heartbeat: "HEARTBEAT.md",
  identity: "IDENTITY.md",
  memory: "MEMORY.md",
  soul: "SOUL.md",
  system: "AGENTS.md"
};

/**
 * Container env var name every generated runtime container is stamped with,
 * so every authority (moltnet, mneme, daimon, and root's own runtime
 * containers) agrees on a single run identifier for causal event envelopes
 * (see specs/CAUSAL.md). Adapters and containers must read run_id from this
 * environment variable — never from model output.
 */
export const NOOPOLIS_RUN_ID_ENV = "NOOPOLIS_RUN_ID";

/**
 * Resolves the shared NOOPOLIS_RUN_ID value from the host/process
 * environment. Returns undefined when unset so callers can decide whether
 * to omit the variable entirely rather than stamp an empty value.
 */
export const resolveNoopolisRunId = (
  env: NodeJS.ProcessEnv = process.env
): string | undefined => env[NOOPOLIS_RUN_ID_ENV]?.trim() || undefined;

/**
 * Ensures `env` carries a NOOPOLIS_RUN_ID: returns the host-provided value
 * untouched when one is already set, otherwise generates a fresh run id,
 * stamps it onto `env`, and returns it. This is the one place a run id is
 * ever generated — every other reader (createRuntimeContainerEnv here,
 * mneme's resolveCausalRunId, daimon's resolveRunId, moltnet's
 * causalRunIDEnv lookup) only ever reads what is already in the process
 * env, so a run id absent from the host env would otherwise leave moltnet
 * causal events with no run_id to stamp (see specs/CAUSAL.md).
 *
 * Callers: only the `run`/`up` execution entrypoints (`runProject.ts`,
 * `upProject.ts`) and their equivalents in opt-in E2E harnesses that build
 * a container directly (e.g. `src/e2e/officeSim.ts`) — never
 * `compileProject.ts`/`buildProject.ts` themselves, which must stay
 * deterministic functions of their inputs. Called once per run/up
 * invocation, before the compile step, so every authority container
 * compiled during that invocation is stamped with the same real id.
 */
export const ensureNoopolisRunId = (
  env: NodeJS.ProcessEnv = process.env
): string => {
  const existing = resolveNoopolisRunId(env);
  if (existing) {
    return existing;
  }

  const generated = `run-${randomUUID().replaceAll("-", "")}`;
  env[NOOPOLIS_RUN_ID_ENV] = generated;
  return generated;
};

export const createCapability = (
  key: string,
  outcome: CapabilityReport["outcome"],
  message = ""
): CapabilityReport => ({
  key,
  message,
  outcome
});

export const createDiagnostic = (
  level: DiagnosticReport["level"],
  message: string
): DiagnosticReport => ({
  level,
  message
});

export const createDocumentFiles = (
  baseDirectory: string,
  documents: ResolvedDocument[]
): EmittedFile[] =>
  documents.map((document) => ({
    content: document.content,
    path:
      document.role in ROLE_FILE_NAMES
        ? `${baseDirectory}/${ROLE_FILE_NAMES[document.role]}`
        : `${baseDirectory}/extras/${document.role.replace(/^extras\./, "")}.md`
  }));

/**
 * Skill roots for the runtimes whose declared skills are read by an external
 * coding-agent CLI engine (`daimon` and `pi`). `.codex/skills` is Codex's own
 * workspace discovery root; `.agents/skills` is the generic cross-engine root
 * that grok, agy, and every other file-reading CLI engine use. Both entries
 * are required and the two emitted files are byte-identical on purpose — this
 * mirrors the Moltnet skill install, which is the working reference: Spawnfile
 * runs `moltnet skill install --runtime codex` for these runtimes and Moltnet
 * writes the same skill to both roots (`resolveMoltnetWorkspaceLayout` in
 * `src/compiler/moltnetClientConfig.ts`, `installMoltnetSkill` in
 * `moltnet/cmd/moltnet/skill.go`). A plain `workspace/skills/` root is read by
 * no engine these two runtimes can host, so anything emitted there is invisible.
 */
export const CLI_ENGINE_SKILL_BASE_DIRECTORIES: readonly string[] = [
  "workspace/.agents/skills",
  "workspace/.codex/skills"
];

/**
 * Skill root for the runtimes that own their own skill loader and read the
 * workspace `skills/` directory directly (`openclaw`, `picoclaw`). Moltnet
 * installs its skill to the same place for those runtimes.
 */
export const WORKSPACE_SKILL_BASE_DIRECTORY = "workspace/skills";

/**
 * Lowers declared skills into emitted `SKILL.md` files. `baseDirectory`
 * accepts a list because a runtime can need the same skill under more than
 * one discovery root (see `CLI_ENGINE_SKILL_BASE_DIRECTORIES`); the emission
 * order is root-major so a generated workspace lists each root's skills
 * together and stays deterministic.
 */
export const createSkillFiles = (
  baseDirectory: string | readonly string[],
  skills: ResolvedSkill[]
): EmittedFile[] =>
  (typeof baseDirectory === "string" ? [baseDirectory] : baseDirectory).flatMap((directory) =>
    skills.map((skill) => ({
      content: skill.content,
      path: `${directory}/${skill.name}/SKILL.md`
    }))
  );

export const createAgentCapabilities = (
  node: ResolvedAgentNode,
  options: {
    mcpOutcome?: CapabilityReport["outcome"];
    memoryMessage?: string;
    memoryOutcome?: CapabilityReport["outcome"];
    moltnetMessage?: string;
    moltnetOutcome?: CapabilityReport["outcome"];
    sandboxOutcome?: CapabilityReport["outcome"];
    scheduleMessage?: string;
    scheduleOutcome?: CapabilityReport["outcome"];
    subagentOutcome?: CapabilityReport["outcome"];
  } = {}
): CapabilityReport[] => {
  const capabilities: CapabilityReport[] = [];

  for (const document of node.docs) {
    capabilities.push(createCapability(`docs.${document.role}`, "supported"));
  }

  for (const skill of node.skills) {
    capabilities.push(createCapability(`skills.${skill.name}`, "supported"));
  }

  for (const server of node.mcpServers) {
    capabilities.push(createCapability(`mcp.${server.name}`, options.mcpOutcome ?? "supported"));
  }

  const memoryAccess = node.memoryAccess ?? [];
  if (memoryAccess.length > 0) {
    const uniqueBanks = new Map(
      memoryAccess.map((access) => [
        `${access.source}:${access.bank.id}`,
        access.bank
      ])
    );
    const outcome = options.memoryOutcome ?? "supported";
    const message = options.memoryMessage ?? "Memory access is available to this runtime";
    capabilities.push(createCapability("memory", outcome, message));
    for (const bank of [...uniqueBanks.values()].sort((left, right) => left.id.localeCompare(right.id))) {
      capabilities.push(createCapability(`memory.${bank.id}`, outcome, message));
    }
  }

  if (node.execution?.model) {
    capabilities.push(createCapability("execution.model", "supported"));
  }

  if (node.execution?.sandbox) {
    capabilities.push(
      createCapability("execution.sandbox", options.sandboxOutcome ?? "supported")
    );
  }

  if (node.schedule) {
    capabilities.push(
      createCapability(
        "agent.schedule",
        options.scheduleOutcome ?? "degraded",
        options.scheduleMessage ?? "Schedule intent is validated but no runtime scheduler is emitted yet"
      )
    );
  }

  if (node.surfaces?.discord) {
    capabilities.push(createCapability("surfaces.discord", "supported"));
  }

  if (node.surfaces?.moltnet) {
    capabilities.push(
      createCapability(
        "surfaces.moltnet",
        options.moltnetOutcome ?? "supported",
        options.moltnetMessage
      )
    );
  }

  if (node.surfaces?.telegram) {
    capabilities.push(createCapability("surfaces.telegram", "supported"));
  }

  if (node.surfaces?.whatsapp) {
    capabilities.push(createCapability("surfaces.whatsapp", "supported"));
  }

  if (node.surfaces?.slack) {
    capabilities.push(createCapability("surfaces.slack", "supported"));
  }

  if (node.subagents.length > 0) {
    capabilities.push(
      createCapability("agent.subagents", options.subagentOutcome ?? "supported")
    );
  }

  return capabilities;
};
