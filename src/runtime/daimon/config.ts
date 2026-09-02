import path from "node:path";

import type { ResolvedAgentNode } from "../../compiler/types.js";
import { parseEveryScheduleMs } from "../scheduleUtils.js";
import { SpawnfileError } from "../../shared/index.js";
import type { ContainerTarget, ContainerTargetInput, EmittedFile } from "../types.js";

import {
  DAIMON_AGY_SUBSCRIPTION_REALM,
  DAIMON_ENGINE_CREDENTIALS,
  DAIMON_GROK_SUBSCRIPTION_REALM,
  DAIMON_GROK_TURN_USAGE_LEDGER
} from "./contractManifest.js";
import {
  DAIMON_INSTANCE_STATE_ROOT,
  daimonMemoryCapabilityFor,
  daimonMemorySelectionWarning,
  daimonMemoryVectorRecallWarning,
  resolveDaimonAgentMemory
} from "./memory.js";
import { assertDaimonScheduleAuthority } from "./scheduleAuthority.js";

// Re-exported so every existing importer of these names keeps working; the
// definitions themselves now live in `./memory.js`.
export {
  DAIMON_INSTANCE_STATE_ROOT,
  daimonMemoryCapabilityFor,
  daimonMemorySelectionWarning,
  daimonMemoryVectorRecallWarning,
  resolveDaimonAgentMemory
};

export const DAIMON_CONFIG_FILE = "daimon-organization-runtime.json";
export const DAIMON_CONTROL_PORT = 19700;
export const DAIMON_MAX_AGENTS = 32;
export const DAIMON_ORGANIZATION_TARGET_ID = "daimon-organization";
export const DAIMON_RUNTIME_ACCEPTANCE_STORE_DIRECTORY = "state/wake-acceptance";
export const DAIMON_RUNTIME_ACCEPTANCE_STORE_ENV = "DAIMON_RUNTIME_ACCEPTANCE_STORE";
export const DAIMON_RUNTIME_ACCEPTANCE_STORE_MOUNT_ID = "daimon-organization-acceptance-store";
export const DAIMON_RUNTIME_READINESS_RECEIPT_ENV = "DAIMON_RUNTIME_READINESS_RECEIPT";
export const DAIMON_WAKE_FUSE_DIRECTORY = "/var/lib/spawnfile/daimon/wake-fuse";
export const DAIMON_WAKE_FUSE_DIRECTORY_ENV = "DAIMON_WAKE_FUSE_DIRECTORY";
export const DAIMON_WAKE_FUSE_MOUNT_ID = "daimon-wake-fuse";
export const DAIMON_RUNTIME_HOMES_DIRECTORY = "runtime-homes";
const DAIMON_MAX_CONFIG_BYTES = 1_048_576;
const DAIMON_MAX_INSTRUCTION_BYTES = 16_384;
const DAIMON_MAX_INSTRUCTION_CODEPOINTS = 16_384;
export const DAIMON_ENGINES = ["agy", "codex", "grok"] as const;
type DaimonEngine = typeof DAIMON_ENGINES[number];

const normalizeSchedule = (node: ResolvedAgentNode): Record<string, unknown> | undefined => {
  const schedule = node.schedule;
  if (!schedule || schedule.kind === "disabled") return schedule ? { kind: "disabled" } : undefined;
  if (schedule.kind === "every") {
    const interval_ms = parseEveryScheduleMs(schedule.every);
    if (interval_ms === null) throw new SpawnfileError("validation_error", `invalid every schedule for ${node.name}`);
    return { kind: "every", interval_ms, prompt: schedule.prompt ?? "Scheduled work" };
  }
  return {
    cron: schedule.cron.trim().replace(/\s+/gu, " "),
    kind: "cron",
    prompt: schedule.prompt ?? "Scheduled work",
    timezone: schedule.timezone ?? "UTC"
  };
};

const formatInstructions = (node: ResolvedAgentNode): string =>
  node.docs.map((document) => `# ${document.role}\n\n${document.content}`).join("\n\n").trim() ||
  `You are ${node.name}. Follow the workspace instructions.`;

const assertPublicInstructionBounds = (agentId: string, instructions: string): void => {
  if (
    Buffer.byteLength(instructions, "utf8") > DAIMON_MAX_INSTRUCTION_BYTES ||
    [...instructions].length > DAIMON_MAX_INSTRUCTION_CODEPOINTS
  ) {
    throw new SpawnfileError(
      "validation_error",
      `Daimon organization runtime v1 instructions for ${agentId} exceed Daimon's public config limit`
    );
  }
};

export const resolveDaimonEngine = (node: ResolvedAgentNode): DaimonEngine => {
  const engine = node.runtime.options.engine ?? "codex";
  if (typeof engine === "string" && (DAIMON_ENGINES as readonly string[]).includes(engine)) {
    return engine as DaimonEngine;
  }
  throw new SpawnfileError(
    "validation_error",
    `Daimon runtime option engine must be one of ${DAIMON_ENGINES.join(", ")}`
  );
};

const moveWorkspaceFile = (file: EmittedFile, slug: string): EmittedFile =>
  file.path.startsWith("workspace/")
    ? { ...file, path: path.posix.join("workspace", "agents", slug, file.path.slice("workspace/".length)) }
    : file;

const renderStartScript = (agents: Array<{
  engine: { kind: DaimonEngine };
  runtimeHomePath: string;
  workspacePath: string;
}>): string => {
  const acceptanceStorePath = `<instance-root>/${DAIMON_RUNTIME_ACCEPTANCE_STORE_DIRECTORY}`;
  const readinessReceiptPath = `${acceptanceStorePath}/runtime-readiness.json`;
  const setup = agents.flatMap((agent) => {
    const credential = agent.engine.kind === "codex"
      ? DAIMON_ENGINE_CREDENTIALS.codex
      : undefined;
    const inbound = path.posix.join(agent.runtimeHomePath, ".daimon-inbound");
    return [
      // The workspace mode is owned by the uid entrypoint, which grants a grok worker
      // group access. Forcing 0700 here would lock that worker out of its own workspace,
      // so create it only when absent and never restate the mode of an existing directory.
      `[ -d ${JSON.stringify(agent.workspacePath)} ] || install -d -m 700 ${JSON.stringify(agent.workspacePath)}`,
      `install -d -m 700 ${[
        agent.runtimeHomePath,
        ...(credential === undefined ? [] : [inbound])
      ].map((entry) => JSON.stringify(entry)).join(" ")}`,
      ...(credential === undefined ? [] : [
        `if [ -e ${JSON.stringify(path.posix.join(agent.runtimeHomePath, credential.sourceRelativePath))} ]; then test "$(stat -c %a ${JSON.stringify(path.posix.join(agent.runtimeHomePath, credential.sourceRelativePath))})" = 600; fi`
      ])
    ];
  });
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `install -d -m 700 ${JSON.stringify(acceptanceStorePath)}`,
    `export ${DAIMON_RUNTIME_ACCEPTANCE_STORE_ENV}=${JSON.stringify(acceptanceStorePath)}`,
    `rm -f ${JSON.stringify(readinessReceiptPath)}`,
    `export ${DAIMON_RUNTIME_READINESS_RECEIPT_ENV}=${JSON.stringify(readinessReceiptPath)}`,
    ...setup,
    'if [ "$#" -gt 0 ]; then exec daimon-runtime "$@"; fi',
    "exec daimon-runtime run --config <config-path>"
  ].join("\n") + "\n";
};

export const createDaimonContainerTargets = async (
  inputs: ContainerTargetInput[]
): Promise<ContainerTarget[]> => {
  const agents = inputs.filter(
    (input): input is ContainerTargetInput & { value: ResolvedAgentNode } =>
      input.kind === "agent" && input.value.kind === "agent"
  );
  if (agents.length === 0) return [];
  if (agents.length > DAIMON_MAX_AGENTS) {
    throw new SpawnfileError(
      "validation_error",
      `Daimon organization runtime v1 supports at most 32 agents; found ${agents.length}. Split the organization across explicit runtime boundaries.`
    );
  }

  const hasSchedules = agents.some((input) => input.value.schedule !== undefined);
  if (hasSchedules) await assertDaimonScheduleAuthority();
  const configAgents = agents
    .map((input) => {
      const memory = resolveDaimonAgentMemory(input.value);
      return {
      engine: { kind: resolveDaimonEngine(input.value) },
      id: input.id,
      instructions: formatInstructions(input.value),
      name: input.value.name,
      ...(input.value.mcpServers.length === 0 ? {} : { mcp: input.value.mcpServers.map((server) => ({
        name: server.name, transport: server.transport, args: server.args ?? [], env: server.env ?? {}, tools: server.tools!,
        ...(server.command ? { command: server.command } : {}), ...(server.url ? { url: server.url } : {}),
        ...(server.auth?.mode === "bearer" ? { authSecretEnv: server.auth.secret } : {})
      })) }),
      ...(memory ? { memory } : {}),
      ...(input.value.surfaces?.moltnet?.length ? { moltnet: {
        cliPath: "/usr/local/bin/moltnet",
        configPath: `<workspace-path>/agents/${input.slug}/.moltnet/config.json`,
        networks: input.value.surfaces.moltnet.map((attachment) => ({ id: attachment.network, rooms: Object.keys(attachment.rooms ?? {}).sort(), dms: attachment.dms?.enabled === true }))
      } } : {}),
      runtimeHomePath: `<instance-root>/${DAIMON_RUNTIME_HOMES_DIRECTORY}/${input.slug}`,
      workspacePath: `<workspace-path>/agents/${input.slug}`,
      ...(hasSchedules ? { schedule: normalizeSchedule(input.value) ?? { kind: "disabled" } } : {})
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  const engineByNodeId = Object.fromEntries(configAgents.map((agent) => [agent.id, agent.engine.kind]));
  const hasAgy = configAgents.some((agent) => agent.engine.kind === "agy");
  const hasGrok = configAgents.some((agent) => agent.engine.kind === "grok");
  const agyRuntimeHomeMounts = configAgents
    .filter((agent) => agent.engine.kind === "agy")
    .map((agent) => ({
      id: `daimon-agy-runtime-home-${path.posix.basename(agent.runtimeHomePath)}`,
      mountPath: agent.runtimeHomePath,
      reason: `Daimon AGY subscription runtime home for ${agent.id}`
    }));
  const portableEngineHomeMounts = configAgents
    .filter((agent) => agent.engine.kind !== "agy")
    .map((agent) => {
      const destinationRelativePath = agent.engine.kind === "grok"
        ? DAIMON_GROK_SUBSCRIPTION_REALM.agentCredentialRelativePath
        : DAIMON_ENGINE_CREDENTIALS.codex.destinationRelativePath;
      return {
        id: `daimon-engine-home-${agent.engine.kind}-${path.posix.basename(agent.runtimeHomePath)}`,
        mountPath: path.posix.join(
          agent.runtimeHomePath,
          path.posix.dirname(destinationRelativePath)
        ),
        reason: `Daimon ${agent.engine.kind} subscription credential home for ${agent.id}`
      };
    });
  const toolStateMounts = configAgents.map((agent) => ({ id: `daimon-tool-state-${path.posix.basename(agent.runtimeHomePath)}`, mountPath: path.posix.join(agent.runtimeHomePath, "tool-state"), reason: `Daimon durable cognition tool receipts for ${agent.id}` }));
  for (const agent of configAgents) assertPublicInstructionBounds(agent.id, agent.instructions);
  const config = {
    agents: configAgents,
    host: {
      bindHost: "127.0.0.1",
      controlTokenEnv: "SPAWNFILE_DAIMON_CONTROL_TOKEN",
      port: DAIMON_CONTROL_PORT
    },
    version: hasSchedules
      ? "noopolis.daimon.organization-runtime.v2"
      : "noopolis.daimon.organization-runtime.v1"
  };
  const serializedConfig = `${JSON.stringify(config, null, 2)}\n`;
  if (Buffer.byteLength(serializedConfig, "utf8") > DAIMON_MAX_CONFIG_BYTES) {
    throw new SpawnfileError("validation_error", "Daimon organization runtime v1 config exceeds Daimon's public config limit");
  }

  return [{
    engineByNodeId,
    files: [
      ...agents.flatMap((input) => input.emittedFiles.map((file) => moveWorkspaceFile(file, input.slug))),
      { content: serializedConfig, path: DAIMON_CONFIG_FILE },
      {
        content: renderStartScript(configAgents),
        mode: 0o755,
        path: "runtime/daimon-start.sh"
      }
    ],
    id: DAIMON_ORGANIZATION_TARGET_ID,
    ...(hasAgy || hasGrok ? {
      opaqueMountTargets: [
        ...(hasAgy ? [DAIMON_AGY_SUBSCRIPTION_REALM.unlockMountPath] : []),
        ...(hasGrok ? [DAIMON_GROK_SUBSCRIPTION_REALM.bootstrapMountPath] : [])
      ],
    } : {}),
    persistentMounts: [...portableEngineHomeMounts, ...toolStateMounts, {
      id: DAIMON_RUNTIME_ACCEPTANCE_STORE_MOUNT_ID,
      mountPath: `<instance-root>/${DAIMON_RUNTIME_ACCEPTANCE_STORE_DIRECTORY}`,
      reason: "Daimon organization durable wake acceptance store"
    }, {
      id: DAIMON_WAKE_FUSE_MOUNT_ID,
      lifecycle: "exclusive-reattach" as const,
      mountPath: DAIMON_WAKE_FUSE_DIRECTORY,
      reason: "Daimon durable wake-fuse admission ledger"
    }, ...(hasGrok ? [{
        id: "daimon-grok-subscription-realm",
        lifecycle: "exclusive-reattach" as const,
        mountPath: DAIMON_GROK_SUBSCRIPTION_REALM.durableMountPath,
        reason: "Daimon host Grok subscription credential realm"
      }] : []), {
        // Non-run-scoped for the same reason as the durable memory mounts (see
        // durableMemoryVolumeName in src/compiler/memoryArtifacts.ts): a
        // run-scoped volume means every `spawnfile up` starts a new empty
        // ledger and cross-deployment usage accounting is impossible. The
        // exclusive reservation this lifecycle carries is a requirement, not a
        // cost.
        // The mount id is deliberately unchanged now that AGY and Codex write
        // here too, not just the broker: it is the volume's identity, and
        // renaming it would orphan every existing deployment's accumulated
        // ledger. Unconditional (not gated on hasGrok/hasAgy) because Daimon's
        // wake fuse now refuses to arm at all if this directory or the ledger
        // file inside it is missing or unreadable (`wakeFuse.ts`,
        // `ensureUsageLedgerReadable`), and Codex also writes here
        // (`engineDispatcher.ts`'s `onTurnUsage`) even in a codex-only
        // organization with no Grok or AGY agent at all.
        id: "daimon-grok-usage-ledger",
        lifecycle: "exclusive-reattach" as const,
        mountPath: DAIMON_GROK_TURN_USAGE_LEDGER.directoryPath,
        reason: "Daimon per-turn engine usage ledger"
      }, ...(hasAgy ? [{
        id: "daimon-agy-subscription-realm",
        // The AGY subscription credential is an OS-keyring entry created by an
        // interactive browser OAuth that has no headless equivalent; it lives
        // in this volume. Without this lifecycle the volume name folds in the
        // run id, so every `spawnfile up` would hand the container an empty
        // keyring and the operator would have to re-enrol by hand.
        lifecycle: "exclusive-reattach" as const,
        mountPath: DAIMON_AGY_SUBSCRIPTION_REALM.durableMountPath,
        reason: "Daimon host AGY subscription realm"
      }, ...agyRuntimeHomeMounts] : [])],
    sourceIds: agents.map((agent) => agent.id).sort()
  }];
};
