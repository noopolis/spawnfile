import { createHash, randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { DAIMON_GATEWAY_KEY_ENV, DAIMON_GATEWAY_URL_ENV, getDaimonEngineDescriptor, isDaimonGatewayRealmMountId } from "../../../runtime/daimon/index.js";
import { daimonHelperControlCall, type DaimonControlCall, type DaimonControlTarget } from "../../../runtime/daimon/control.js";
import { RUNTIME_INSTALL_ROOT } from "../../../runtime/container.js";
import { parseUsageLedger, type UsageRecord } from "../../../runtime/usageLedger.js";
import { parseUsageRequestLedger } from "../../../runtime/usageRequestLedger.js";
import { DAIMON_GROK_TURN_USAGE_LEDGER } from "../../../runtime/daimon/contractManifest.js";
import { SpawnfileError } from "../../../shared/index.js";
import { buildCompiledProject } from "../../buildProject.js";
import { compileProject } from "../../compileProject.js";
import { resolveDeploymentLineage } from "../../deploymentLineage.js";
import { slugify } from "../../helpers.js";
import { createDockerRunInvocation, runDockerContainer } from "../../runProject.js";
import { executeDockerRunWithSupportCleanup } from "../../runProjectLifecycle.js";
import { createTrialDocker, waitFor, type TrialDocker } from "./docker.js";
import type { TrainingGatewayAccess } from "./gateway.js";
import { writeTrialProject } from "./project.js";

/**
 * Lineage namespace for training trials: every trial derives its own durable
 * volume names, so no trial ever attaches production's, dev's or another
 * trial's state (see `deploymentLineage.ts`).
 */
export const TRAINING_TRIAL_LINEAGE_NAMESPACE = "training";
const CONTROL_TOKEN_ENV = "SPAWNFILE_DAIMON_CONTROL_TOKEN";
const WAKE_VERSION = "noopolis.daimon.wake.v2";
const TERMINAL = new Set(["completed", "failed", "stopped"]);
const MAX_TRANSCRIPT_BYTES = 1024 * 1024;

export interface TrialOptions {
  agentManifestPath: string;
  instructions: string;
  trialId: string;
  /** Fresh per trial; holds the trial project, compile output and boot env file. */
  directory: string;
  docker?: TrialDocker;
  control?: DaimonControlCall;
}

export interface TrialWake {
  state: "completed" | "failed" | "stopped" | "timeout";
  acceptanceId: string;
  executionId: string | null;
  code: string | null;
  text: string;
  /** Usage ledger rows this wake appended; empty means none were written, never zero spend. */
  usage: UsageRecord[];
  /** The engine's own newest session record, bounded; null when none exists. */
  transcript: string | null;
  /** Per model request of this wake, the tool-call names its response carried; null where the runtime could not say. */
  requestToolCalls: (readonly string[] | null)[];
}

export interface BootedTrial {
  container: string;
  wake(text: string, options: { deliveryId: string; timeoutMs: number; signal?: AbortSignal }): Promise<TrialWake>;
  /** Credential-shaped files anywhere in the trial container (expected: none). */
  scanCredentials(): Promise<string[]>;
  teardown(): Promise<void>;
}

export interface PreparedTrial {
  image: string;
  runtimeRoot: string;
  engines: string[];
  agentId: string;
  boot(gateway: TrainingGatewayAccess, options?: { readyTimeoutMs?: number }): Promise<BootedTrial>;
  dispose(): Promise<void>;
}

/** Compiles and builds the trial's one-agent organization under its own lineage, as production does. */
export const prepareTrial = async (options: TrialOptions): Promise<PreparedTrial> => {
  const docker = options.docker ?? createTrialDocker();
  // Readable and collision-free: trial ids may share long prefixes.
  const slug = `${slugify(options.trialId).slice(0, 32) || "trial"}-${createHash("sha256").update(options.trialId).digest("hex").slice(0, 8)}`;
  const image = `spawnfile-training-trial:${slug}`;
  const compiled = await (async () => {
    const project = await writeTrialProject(options.agentManifestPath, options.instructions, path.join(options.directory, "project"));
    const compiled = await compileProject(project, {
      deploymentLineage: resolveDeploymentLineage(slug, TRAINING_TRIAL_LINEAGE_NAMESPACE),
      outputDirectory: path.join(options.directory, "out")
    });
    await buildCompiledProject(project, compiled, { imageTag: image });
    return compiled;
  })().catch(async (error: unknown) => {
    await rm(options.directory, { recursive: true, force: true });
    throw error;
  });
  const instance = compiled.report.container?.runtime_instances.find((entry) => entry.runtime === "daimon");
  const agents = Object.entries(instance?.engine_by_node_id ?? {});
  if (!instance || agents.length !== 1) throw new SpawnfileError("validation_error", "A production-booted trial compiles exactly one Daimon agent");
  const [agentId] = agents[0]!;
  const home = instance.agent_paths?.[agentId]?.home_path;
  // The engine writes its own session records under its home inside the agent's runtime home.
  const engineHome = getDaimonEngineDescriptor(agents[0]![1])?.homeDirectory;
  const sessionsPath = home && engineHome !== undefined ? path.posix.join(home, engineHome, "sessions") : null;
  const dispose = async (): Promise<void> => {
    await docker(["image", "rm", "-f", image]).catch(() => undefined);
    await rm(options.directory, { recursive: true, force: true });
  };
  return {
    agentId, dispose, image,
    engines: agents.map(([, engine]) => engine),
    runtimeRoot: `${RUNTIME_INSTALL_ROOT}/daimon`,
    boot: async (gateway, bootOptions = {}) => {
      const token = randomBytes(32).toString("base64url");
      const container = `spawnfile-trial-${slug}`;
      await mkdir(options.directory, { recursive: true });
      const envFilePath = path.join(options.directory, "boot.env");
      // The boot inputs: control token, gateway URL and key. No login, no realm.
      await writeFile(envFilePath, `${CONTROL_TOKEN_ENV}=${token}\n${DAIMON_GATEWAY_URL_ENV}=${gateway.url}\n${DAIMON_GATEWAY_KEY_ENV}=${gateway.key}\n`, { mode: 0o600 });
      const invocation = await createDockerRunInvocation(compiled, image, {
        containerName: container, deploymentName: slug, detach: true, envFilePath, network: gateway.network
      });
      const volumes = (compiled.report.container?.persistent_mounts ?? [])
        .filter((mount) => !isDaimonGatewayRealmMountId(mount.id)).map((mount) => mount.volume_name);
      const teardown = async (): Promise<void> => {
        await docker(["rm", "-f", container]).catch(() => undefined);
        for (const volume of volumes) await docker(["volume", "rm", "-f", volume]).catch(() => undefined);
        await rm(invocation.supportDirectory, { recursive: true, force: true });
        await rm(envFilePath, { force: true });
      };
      try {
        await executeDockerRunWithSupportCleanup(invocation, runDockerContainer);
        await rm(envFilePath, { force: true });
        const target: DaimonControlTarget = { containerRef: container, dockerArgs: [], dockerCommand: "docker", imageRef: image, token };
        const call = options.control ?? daimonHelperControlCall;
        await waitFor(async () => {
          if (await docker(["inspect", "--format", "{{.State.Running}}", container]) !== "true") {
            const logs = await docker(["logs", "--tail", "30", container]).catch(() => "");
            throw new SpawnfileError("runtime_error", `trial organization exited before readiness: ${logs.replace(/\s+/gu, " ").slice(-600)}`);
          }
          return call(target, "GET", "/v2/availability").then((response) => response.status === 200, () => false);
        }, bootOptions.readyTimeoutMs ?? 180_000, "trial organization readiness", 1_000);
        return createBootedTrial({ agentId, call, container, docker, sessionsPath, target, teardown });
      } catch (error) {
        await teardown();
        throw error;
      }
    }
  };
};

/** Daimon's per-request stream sits beside the usage ledger. */
const REQUEST_LEDGER = path.posix.join(path.posix.dirname(DAIMON_GROK_TURN_USAGE_LEDGER.filePath), "requests.jsonl");

const readRequestToolCalls = async (docker: TrialDocker, container: string, agentId: string, deliveryId: string): Promise<(readonly string[] | null)[]> => {
  const text = await docker(["exec", container, "cat", REQUEST_LEDGER]).catch(() => "");
  return parseUsageRequestLedger(text).filter((row) => row.agent === agentId && row.wake === deliveryId).map((row) => row.tool_calls ?? null);
};

const readLedger = async (docker: TrialDocker, container: string): Promise<UsageRecord[]> => {
  const text = await docker(["exec", container, "cat", DAIMON_GROK_TURN_USAGE_LEDGER.filePath]).catch(() => "");
  return parseUsageLedger(text);
};

const createBootedTrial = (input: {
  agentId: string; call: DaimonControlCall; container: string; docker: TrialDocker;
  sessionsPath: string | null; target: DaimonControlTarget; teardown: () => Promise<void>;
}): BootedTrial => {
  let seenRows = 0;
  return {
    container: input.container,
    teardown: input.teardown,
    scanCredentials: async () => {
      const found = await input.docker(["exec", input.container, "find", "/", "-xdev", "(", "-name", "auth.json", "-o", "-name", "*token*", "-o", "-name", "*bootstrap-auth*", ")",
        "-not", "-path", "/proc/*", "-not", "-path", "/sys/*", "-not", "-path", "/usr/*", "-not", "-path", "/opt/spawnfile/runtime-installs/*"], { timeoutMs: 60_000 }).catch((error: Error) => error.message);
      return found.split("\n").filter(Boolean);
    },
    wake: async (text, options) => {
      const body = { agent_id: input.agentId, delivery_id: options.deliveryId,
        event: { version: WAKE_VERSION, kind: "manual", text, occurred_at: new Date().toISOString() } };
      const accepted = await input.call(input.target, "POST", "/v2/wakes", body);
      const acceptance = JSON.parse(accepted.body) as { state?: string; acceptance_id?: string; code?: string };
      if (accepted.status !== 202 || acceptance.state !== "accepted" || !acceptance.acceptance_id) {
        throw new SpawnfileError("runtime_error", `trial wake was not accepted (HTTP ${accepted.status}${acceptance.code ? `, ${acceptance.code}` : ""})`);
      }
      const id = acceptance.acceptance_id;
      let receipt: { state?: string; execution_id?: string; code?: string; text?: string } = {};
      const deadline = Date.now() + options.timeoutMs;
      while (!TERMINAL.has(receipt.state ?? "") && Date.now() < deadline && !options.signal?.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const response = await input.call(input.target, "GET", `/v2/wake-receipts/${id}`);
        if (response.status === 200) receipt = JSON.parse(response.body) as typeof receipt;
      }
      const rows = await readLedger(input.docker, input.container);
      const usage = rows.slice(seenRows).filter((row) => row.agent === input.agentId);
      seenRows = rows.length;
      return {
        acceptanceId: id, code: receipt.code ?? null, executionId: receipt.execution_id ?? null, usage,
        state: TERMINAL.has(receipt.state ?? "") ? receipt.state as TrialWake["state"] : "timeout",
        text: receipt.text ?? "",
        requestToolCalls: await readRequestToolCalls(input.docker, input.container, input.agentId, options.deliveryId),
        transcript: input.sessionsPath === null ? null : await readTranscript(input.docker, input.container, input.sessionsPath)
      };
    }
  };
};

/** The engine's newest session record, bounded. */
const readTranscript = async (docker: TrialDocker, container: string, sessionsPath: string): Promise<string | null> => {
  const newest = await docker(["exec", container, "sh", "-c", 'find "$1" -name "*.jsonl" -type f -printf "%T@ %p\\n" 2>/dev/null | sort -n | tail -1 | cut -d" " -f2-', "sh", sessionsPath]).catch(() => "");
  if (!newest) return null;
  const text = await docker(["exec", container, "head", "-c", String(MAX_TRANSCRIPT_BYTES), newest]).catch(() => "");
  return text || null;
};
