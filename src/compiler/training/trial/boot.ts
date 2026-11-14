import { createHash, randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ResolvedAuthProfile } from "../../../auth/index.js";
import { DAIMON_GATEWAY_KEY_ENV, DAIMON_GATEWAY_URL_ENV, daimonProfileRealmVolume, getDaimonEngineDescriptor, isDaimonGatewayRealmMountId } from "../../../runtime/daimon/index.js";
import { daimonHelperControlCall, type DaimonControlCall, type DaimonControlTarget } from "../../../runtime/daimon/control.js";
import { RUNTIME_INSTALL_ROOT } from "../../../runtime/container.js";
import type { UsageRecord } from "../../../runtime/usageLedger.js";
import { maskSecrets, SpawnfileError } from "../../../shared/index.js";
import { buildCompiledProject } from "../../buildProject.js";
import { compileProject } from "../../compileProject.js";
import { resolveDeploymentLineage } from "../../deploymentLineage.js";
import { slugify } from "../../helpers.js";
import { createDockerRunInvocation, runDockerContainer } from "../../runProject.js";
import { executeDockerRunWithSupportCleanup } from "../../runProjectLifecycle.js";
import { createTrialDocker, waitFor, type TrialDocker } from "./docker.js";
import { captureTrialEvidence, type TrialEvidenceCaptureCall } from "./evidence.js";
import type { TrainingGatewayAccess } from "./gateway.js";
import { HOME_LOGIN_FILES, saveHomeLogin, seedHomeLogin, type HomeLogin } from "./homeLogin.js";
import { fillMomentVolumes, momentVolumesFor } from "./momentVolumes.js";
import { writeTrialProject } from "./project.js";
import { agentExecutionError, readLedger, readRequestLedger, readTranscript, requestUsage } from "./trialReads.js";
import { renderMomentWake, trainingMomentSchema, type TrainingMoment } from "../moments.js";

/**
 * Lineage namespace for training trials: every trial derives its own durable
 * volume names, so no trial ever attaches production's, dev's or another
 * trial's state (see `deploymentLineage.ts`).
 */
export const TRAINING_TRIAL_LINEAGE_NAMESPACE = "training";
const CONTROL_TOKEN_ENV = "SPAWNFILE_DAIMON_CONTROL_TOKEN";
const WAKE_VERSION = "noopolis.daimon.wake.v2";
const TERMINAL = new Set(["completed", "failed", "stopped"]);
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const ABSENT = "__spawnfile_trial_output_absent__";
/** Every trial volume is named for the trial: no trial ever holds production's, dev's or another trial's state. */
export const TRIAL_VOLUME_PREFIX = "spawnfile-training-trial-";

/**
 * Renames every compiled volume except the gatewayed login realms (which a gatewayed trial never mounts)
 * to one of the trial's own, so team resources declared by name and project-derived homes are fresh per trial.
 */
export const isolateTrialVolumes = (container: { persistent_mounts?: { id: string; volume_name: string }[] } | undefined, slug: string): void => {
  for (const mount of container?.persistent_mounts ?? []) {
    if (isDaimonGatewayRealmMountId(mount.id)) continue;
    mount.volume_name = `${TRIAL_VOLUME_PREFIX}${slug}-${createHash("sha256").update(mount.id).digest("hex").slice(0, 12)}`;
  }
};

export interface TrialOptions {
  agentManifestPath: string;
  /** The subject's project root manifest (default: the agent's own); its team context compiles with the subject. */
  projectManifestPath?: string;
  instructions: string;
  trialId: string;
  /** Fresh per trial; holds the trial project, compile output and boot env file. */
  directory: string;
  docker?: TrialDocker;
  control?: DaimonControlCall;
  /** Saves the container's evidence before teardown (tests only; default: the real capture). */
  evidence?: TrialEvidenceCaptureCall;
}

export interface TrialWake {
  /** `deferred`: Daimon left the delivery deferred: the subject's own choice when `failure` is null, else Daimon deferring it after a failed retry. */
  state: "completed" | "deferred" | "failed" | "stopped" | "timeout";
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
  /**
   * The engine failure Daimon reported for this delivery, in full, secrets masked: a failed receipt's detail, or
   * the agent's execution error when the delivery did not complete (Daimon deferred it after retrying a failed
   * execution, or its retry was still open at the trial's deadline). Null when none.
   */
  failure: string | null;
}

export interface BootedTrial {
  container: string;
  wake(text: string, options: { deliveryId: string; timeoutMs: number; signal?: AbortSignal }): Promise<TrialWake>;
  /** A workspace-relative file the subject left; null when absent. */
  read(path: string): Promise<string | null>;
  /** Credential-shaped files anywhere in the trial container (expected: none). */
  scanCredentials(): Promise<string[]>;
  /**
   * Saves the container's evidence, then removes it and its volumes. Resolves with the failure its runtime
   * still reported for the agent at that moment (secrets masked), or null: what a turn cut short never returned.
   */
  teardown(): Promise<string | null>;
}

export interface TrialBootOptions {
  /**
   * Where this container's evidence is kept before it is removed, on every teardown path: its whole log and
   * the engine records its runtime declares (`evidence.ts`). The operator's own disk, outside any volume.
   */
  evidenceDirectory: string;
  readyTimeoutMs?: number;
  realms?: ResolvedAuthProfile;
  moment?: unknown;
}

export interface PreparedTrial {
  image: string;
  runtimeRoot: string;
  engines: string[];
  agentId: string;
  /**
   * Boots the organization. `gateway` is null for an organization on no
   * gatewayed engine; `realms` is a profile view holding only the
   * volume-held logins (`spawnfile auth login`) this organization mounts.
   */
  boot(gateway: TrainingGatewayAccess | null, options: TrialBootOptions): Promise<BootedTrial>;
  /** Runs the organization's own `auth <engine> login` attached to the operator's terminal, or returns its argv on `dryRun`. */
  login(realms: ResolvedAuthProfile, options?: { dryRun?: boolean }): Promise<readonly string[]>;
  dispose(): Promise<void>;
}

/**
 * Readable and collision-free: trial ids may share long prefixes. The cut can
 * land just after a hyphen, so it is trimmed: the slug names a kebab-case
 * deployment, which refuses a doubled hyphen.
 */
export const trialSlug = (trialId: string): string =>
  `${slugify(trialId).slice(0, 32).replace(/-+$/u, "") || "trial"}-${createHash("sha256").update(trialId).digest("hex").slice(0, 8)}`;

/** Compiles and builds the trial's one-agent organization under its own lineage, as production does. */
export const prepareTrial = async (options: TrialOptions): Promise<PreparedTrial> => {
  const docker = options.docker ?? createTrialDocker();
  const slug = trialSlug(options.trialId);
  const image = `spawnfile-training-trial:${slug}`;
  const compiled = await (async () => {
    const project = await writeTrialProject(options.projectManifestPath ?? options.agentManifestPath, options.agentManifestPath,
      options.instructions, path.join(options.directory, "project"));
    const compiled = await compileProject(project.manifestPath, {
      deploymentLineage: resolveDeploymentLineage(slug, TRAINING_TRIAL_LINEAGE_NAMESPACE),
      manifestOverrides: project.manifestOverrides,
      outputDirectory: path.join(options.directory, "out")
    });
    await buildCompiledProject(project.manifestPath, compiled, { imageTag: image });
    isolateTrialVolumes(compiled.report.container, slug);
    return compiled;
  })().catch(async (error: unknown) => {
    await rm(options.directory, { recursive: true, force: true });
    throw error;
  });
  const instance = compiled.report.container?.runtime_instances.find((entry) => entry.runtime === "daimon");
  const agents = Object.entries(instance?.engine_by_node_id ?? {});
  if (!instance || agents.length !== 1) throw new SpawnfileError("validation_error", "A production-booted trial compiles exactly one Daimon agent");
  const [agentId, engine] = agents[0]!;
  const home = instance.agent_paths?.[agentId]?.home_path;
  const workspace = instance.agent_paths?.[agentId]?.workspace_path ?? null;
  // The engine writes its own session records under its home inside the agent's runtime home.
  const descriptor = getDaimonEngineDescriptor(engine);
  const engineHome = descriptor?.homeDirectory;
  // What the engine's runtime declares of its own turn records, and every login file no declared path may reach.
  const diagnostics = home ? [{ agentId, home, paths: descriptor?.diagnostics?.paths ?? [] }] : [];
  const loginPaths = [...new Set([...(HOME_LOGIN_FILES[engine] ?? []), descriptor?.credentialMaterial?.destinationRelativePath,
    descriptor && "fileName" in descriptor.auth ? path.posix.join(descriptor.homeDirectory, descriptor.auth.fileName) : undefined]
    .filter((file): file is string => Boolean(file && home)).map((file) => path.posix.join(home!, file)))];
  const sessionsPath = home && engineHome !== undefined ? path.posix.join(home, engineHome, "sessions") : null;
  const lineageVolumes = (realms: ResolvedAuthProfile | undefined): string[] => (compiled.report.container?.persistent_mounts ?? [])
    .filter((mount) => !isDaimonGatewayRealmMountId(mount.id) && daimonProfileRealmVolume(mount.id, realms) === undefined)
    .map((mount) => mount.volume_name);
  /**
   * The profile's home login (`spawnfile auth login`) for this organization's
   * fresh runtime home: seeded into it before the container starts, written
   * back after it stops. Only the engine's login files cross; the home itself
   * is the trial's own and is removed with it.
   */
  const homeLoginFor = (realms: ResolvedAuthProfile | undefined): HomeLogin | undefined => {
    const files = HOME_LOGIN_FILES[engine];
    const loginVolume = realms?.realms?.[engine]?.homeVolume;
    if (!files || !loginVolume) return undefined;
    const mount = (compiled.report.container?.persistent_mounts ?? []).find((entry) => entry.mount_path === home);
    if (!mount) throw new SpawnfileError("validation_error", `The ${engine} runtime home of ${agentId} is not a persistent mount; its login cannot be seeded`);
    return { files, homeMountPath: mount.mount_path, homeVolume: mount.volume_name, loginVolume };
  };
  const removeVolumes = async (volumes: readonly string[]): Promise<void> => {
    for (const volume of volumes) if (volume.startsWith(TRIAL_VOLUME_PREFIX)) await docker(["volume", "rm", "-f", volume]).catch(() => undefined);
  };
  const dispose = async (): Promise<void> => {
    await docker(["image", "rm", "-f", image]).catch(() => undefined);
    await rm(options.directory, { recursive: true, force: true });
  };
  return {
    agentId, dispose, image,
    engines: agents.map(([, engine]) => engine),
    runtimeRoot: `${RUNTIME_INSTALL_ROOT}/daimon`,
    login: async (realms, loginOptions = {}) => {
      const homeLogin = homeLoginFor(realms);
      const invocation = await createDockerRunInvocation(compiled, image, {
        authProfile: realms, command: ["auth", engine, "login", "--config", instance.config_path],
        containerName: `spawnfile-login-${slug}`, interactive: true
      });
      if (loginOptions.dryRun) {
        await rm(invocation.supportDirectory, { recursive: true, force: true });
        return [invocation.command, ...invocation.args];
      }
      try {
        await executeDockerRunWithSupportCleanup(invocation, runDockerContainer);
        if (homeLogin) await saveHomeLogin(docker, image, homeLogin);
      } finally { await removeVolumes(lineageVolumes(realms)); }
      return [invocation.command, ...invocation.args];
    },
    boot: async (gateway, bootOptions) => {
      const token = randomBytes(32).toString("base64url");
      const container = `spawnfile-trial-${slug}`;
      await mkdir(options.directory, { recursive: true });
      const envFilePath = path.join(options.directory, "boot.env");
      // The boot inputs: control token, plus the gateway URL and key. No gatewayed login, no
      // gatewayed realm; only a volume-held login of the selected profile is mounted.
      const gatewayEnv = gateway ? `${DAIMON_GATEWAY_URL_ENV}=${gateway.url}\n${DAIMON_GATEWAY_KEY_ENV}=${gateway.key}\n` : "";
      await writeFile(envFilePath, `${CONTROL_TOKEN_ENV}=${token}\n${gatewayEnv}`, { mode: 0o600 });
      const invocation = await createDockerRunInvocation(compiled, image, {
        authProfile: bootOptions.realms ?? null, containerName: container, deploymentName: slug, detach: true, envFilePath,
        ...(gateway ? { network: gateway.network } : {})
      });
      const secrets = [token, ...(gateway ? [gateway.key] : [])];
      const volumes = lineageVolumes(bootOptions.realms);
      const moment = bootOptions.moment === undefined ? undefined : trainingMomentSchema.parse(bootOptions.moment);
      const homeLogin = homeLoginFor(bootOptions.realms);
      const target: DaimonControlTarget = { containerRef: container, dockerArgs: [], dockerCommand: "docker", imageRef: image, token };
      const call = options.control ?? daimonHelperControlCall;
      let ready = false;
      const teardown = async (): Promise<string | null> => {
        try {
          const reported = ready ? await agentExecutionError(call, target, agentId) : null;
          const failure = reported === null ? null : maskSecrets(reported, secrets);
          // Stopped, not killed: the runtime's last lines reach its log, and the engine finishes any login rewrite.
          await docker(["stop", "--time", "10", container]).catch(() => undefined);
          // Everything the container can still say, before it and its volumes are gone.
          await (options.evidence ?? captureTrialEvidence)({ container, diagnostics, directory: bootOptions.evidenceDirectory, loginPaths, secrets,
            notes: failure === null ? {} : { "runtime-failure.txt": failure } });
          await docker(["rm", "-f", container]).catch(() => undefined);
          if (homeLogin) await saveHomeLogin(docker, image, homeLogin);
          return failure;
        } finally {
          await removeVolumes(volumes);
          await rm(invocation.supportDirectory, { recursive: true, force: true });
          await rm(envFilePath, { force: true });
        }
      };
      try {
        if (homeLogin) await seedHomeLogin(docker, image, homeLogin);
        if (moment) await fillMomentVolumes(docker, image, momentVolumesFor(moment, compiled.report.container ?? {}));
        await executeDockerRunWithSupportCleanup(invocation, runDockerContainer);
        await rm(envFilePath, { force: true });
        await waitFor(async () => {
          // A restart means the organization already exited once (`--restart unless-stopped` hides it).
          if (await docker(["inspect", "--format", "{{.State.Running}} {{.RestartCount}}", container]) !== "true 0") {
            const logs = await docker(["logs", "--tail", "30", container], { combined: true }).catch(() => "");
            throw new SpawnfileError("runtime_error", `trial organization exited before readiness: ${logs.replace(/\s+/gu, " ").slice(-600)}`);
          }
          return call(target, "GET", "/v2/availability").then((response) => response.status === 200, () => false);
        }, bootOptions.readyTimeoutMs ?? 180_000, "trial organization readiness", 1_000);
        ready = true;
        // Production's own post-start operator steps, inside the container with its environment.
        for (const step of moment?.afterBoot ?? []) {
          await docker(["exec", "--user", step.user, ...Object.entries(step.env ?? {}).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
            container, ...step.command], { timeoutMs: 120_000 });
        }
        return createBootedTrial({ agentId, call, container, docker, moment, secrets, sessionsPath, target, teardown, workspace });
      } catch (error) {
        // The boot failure is the error to report, not a teardown that follows it.
        await teardown().catch(() => undefined);
        throw error;
      }
    }
  };
};

const createBootedTrial = (input: {
  agentId: string; call: DaimonControlCall; container: string; docker: TrialDocker; moment: TrainingMoment | undefined;
  secrets: readonly string[]; sessionsPath: string | null; target: DaimonControlTarget; teardown: () => Promise<string | null>; workspace: string | null;
}): BootedTrial => {
  let seenRows = 0;
  let seenRequests = 0;
  return {
    container: input.container,
    teardown: input.teardown,
    scanCredentials: async () => {
      const found = await input.docker(["exec", input.container, "find", "/", "-xdev", "(", "-name", "auth.json", "-o", "-name", "*token*", "-o", "-name", "*bootstrap-auth*", ")",
        "-not", "-path", "/proc/*", "-not", "-path", "/sys/*", "-not", "-path", "/usr/*", "-not", "-path", "/opt/spawnfile/runtime-installs/*"], { timeoutMs: 60_000 }).catch((error: Error) => error.message);
      return found.split("\n").filter(Boolean);
    },
    read: async (file) => {
      if (input.workspace === null || file.startsWith("/") || file.split("/").some((part) => !part || part === "." || part === "..")) return null;
      const text = await input.docker(["exec", input.container, "sh", "-c",
        'if [ -f "$1" ]; then head -c "$2" -- "$1"; else printf "%s" "$3"; fi', "sh", path.posix.join(input.workspace, file), String(MAX_OUTPUT_BYTES), ABSENT]);
      return text === ABSENT ? null : text;
    },
    wake: async (text, options) => {
      // A moment's wake arrives as production Moltnet delivers a room message: kind message at its own instant.
      const event = input.moment
        ? { version: WAKE_VERSION, kind: "message", text: renderMomentWake(input.moment.wake), occurred_at: input.moment.at }
        : { version: WAKE_VERSION, kind: "manual", text, occurred_at: new Date().toISOString() };
      const body = { agent_id: input.agentId, delivery_id: options.deliveryId, event };
      const accepted = await input.call(input.target, "POST", "/v2/wakes", body);
      const acceptance = JSON.parse(accepted.body) as { state?: string; acceptance_id?: string; code?: string };
      if (accepted.status !== 202 || acceptance.state !== "accepted" || !acceptance.acceptance_id) {
        throw new SpawnfileError("runtime_error", `trial wake was not accepted (HTTP ${accepted.status}${acceptance.code ? `, ${acceptance.code}` : ""})`);
      }
      const id = acceptance.acceptance_id;
      let receipt: { state?: string; execution_id?: string; code?: string; text?: string; deferred?: boolean } = {};
      const deadline = Date.now() + options.timeoutMs;
      // The subject may end its turn by deferring the delivery: Daimon returns it to `accepted`, marked deferred,
      // to wait for input a trial never sends. That ends the trial's turn as surely as completing it.
      const ended = (): boolean => TERMINAL.has(receipt.state ?? "") || (receipt.state === "accepted" && receipt.deferred === true);
      while (!ended() && Date.now() < deadline && !options.signal?.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const response = await input.call(input.target, "GET", `/v2/wake-receipts/${id}`);
        if (response.status === 200) receipt = JSON.parse(response.body) as typeof receipt;
      }
      // A delivery can be disposed mid-turn (attention's disposition tool), so its receipt ends before its turn
      // does; the turn's usage and transcript land when the execution ends, which only the activity shows. A
      // deferral clears the receipt's execution id, so the execution is found by the delivery it carries.
      const execution = receipt.execution_id;
      while (Date.now() < deadline && !options.signal?.aborted) {
        const activity = await input.call(input.target, "GET", "/v2/activity");
        const executions = activity.status === 200 ? (JSON.parse(activity.body) as { executions?: { execution_id?: string; delivery_ids?: string[] }[] }).executions ?? [] : [];
        if (!executions.some((entry) => entry.execution_id === execution || entry.delivery_ids?.includes(options.deliveryId))) break;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      // Daimon defers a delivery whose execution failed twice, and a delivery still open at the deadline may be
      // on the retry of a failed execution; only the agent's availability names that failure.
      const reported = receipt.state === "failed" ? receipt.text || null
        : TERMINAL.has(receipt.state ?? "") ? null : await agentExecutionError(input.call, input.target, input.agentId);
      const failure = reported === null ? null : maskSecrets(reported, input.secrets);
      const rows = await readLedger(input.docker, input.container);
      const requests = await readRequestLedger(input.docker, input.container);
      const fresh = requests.slice(seenRequests).filter((row) => row.agent === input.agentId);
      const turnUsage = rows.slice(seenRows).filter((row) => row.agent === input.agentId);
      const usage = turnUsage.length ? turnUsage : requestUsage(fresh, input.agentId);
      seenRows = rows.length;
      seenRequests = requests.length;
      return {
        acceptanceId: id, code: receipt.code ?? null, executionId: receipt.execution_id ?? null, usage,
        state: TERMINAL.has(receipt.state ?? "") ? receipt.state as TrialWake["state"] : ended() ? "deferred" : "timeout",
        text: receipt.text ?? "",
        failure,
        requestToolCalls: fresh.filter((row) => row.wake === options.deliveryId).map((row) => row.tool_calls ?? null),
        transcript: input.sessionsPath === null ? null : await readTranscript(input.docker, input.container, input.sessionsPath)
      };
    }
  };
};
