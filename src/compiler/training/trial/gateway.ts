import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ResolvedAuthProfile } from "../../../auth/index.js";
import { DAIMON_GATEWAY_PORT, daimonGatewayBootstrapMountPath, daimonGatewayedEngines, daimonGatewayRealmPath } from "../../../runtime/daimon/gateway.js";
import { assertSafeDaimonSourceFile, daimonSourcePathForEngine } from "../../../runtime/daimon/runAuth.js";
import { DAIMON_DOCKER_RUNTIME_SECURITY_ARGS, SpawnfileError } from "../../../shared/index.js";
import { createDockerTargetExecutors } from "../../../target/dockerCommandExecutor.js";
import { removeExactDockerResource } from "../../../target/dockerResources.js";
import { createDockerResourceSpec, executeDockerResource } from "../../../target/dockerResourcesProvider.js";
import { parseOpaqueTargetHandle } from "../../../target/contracts.js";
import {
  DAIMON_GATEWAY_SIDECAR_ALIAS,
  DAIMON_GATEWAY_SIDECAR_KEY_ENV,
  DAIMON_GATEWAY_SIDECAR_URL,
  renderDaimonGatewaySidecarScript
} from "../../containerDaimonGatewayRender.js";
import { slugify } from "../../helpers.js";
import { createTrialDocker, waitFor, type TrialDocker } from "./docker.js";

export interface TrainingGatewayOptions {
  /** Any compiled image of the subject: it carries the pinned Daimon runtime the gateway binary comes from. */
  image: string;
  runtimeRoot: string;
  engines: readonly string[];
  authProfile: ResolvedAuthProfile;
  /** Training run identity; names the run's networks and labels every resource. */
  runId: string;
  docker?: TrialDocker;
  /** Overrides the rendered sidecar script (tests and diagnostics only). */
  script?: (script: string) => string;
  readyTimeoutMs?: number;
}

/** What a trial needs to boot against the sidecar: one agent contract, never a login. */
export interface TrainingGatewayAccess {
  url: string;
  key: string;
  /** Internal (no egress) network the trials join; only the gateway reaches the internet. */
  network: string;
}

export interface TrainingGateway extends TrainingGatewayAccess {
  container: string;
  realmVolumes: readonly string[];
  /** Stops and removes the sidecar and both networks. The realm volumes stay: they are the login. */
  stop(): Promise<void>;
  /** Replaces a dead or stuck sidecar in place: same key, networks and realm, so booted trials keep working. */
  restart(script?: (script: string) => string): Promise<void>;
}

const hex = (value: string): string => createHash("sha256").update(value).digest("hex");
const opaque = (value: string) => parseOpaqueTargetHandle(`opaque_${hex(value)}`);
const LABEL = "spawnfile.training-gateway";

/** One durable realm volume per auth profile and engine: the gateway is its sole holder (exclusive flock). */
export const trainingGatewayRealmVolume = (profile: string, engine: string): string =>
  `spawnfile-training-${slugify(profile) || "profile"}-${engine}-realm`;

/**
 * Places Daimon's auth gateway as a sidecar for one training run: a container
 * from the subject's own compiled image (the pinned Daimon runtime is a
 * scratch copy source and runs nothing by itself), with the production Docker
 * security posture, owning the engine realm volume, on a dedicated egress
 * network plus the run's internal network that the trials join. Nothing is
 * published to the host. The bootstrap leaf of the selected auth profile is
 * staged through the same gate as `spawnfile up`.
 */
export const startTrainingGateway = async (options: TrainingGatewayOptions): Promise<TrainingGateway> => {
  const docker = options.docker ?? createTrialDocker();
  const descriptors = daimonGatewayedEngines(options.engines);
  if (descriptors.length === 0) throw new SpawnfileError("validation_error", "Training gateway needs a gatewayed engine");
  const context = await docker(["context", "show"]);
  const executor = createDockerTargetExecutors().resource;
  const internal = createDockerResourceSpec({
    kind: "data_network", operationHandle: opaque(`${options.runId}\0network`), requestDigest: `sha256:${hex(options.runId)}`,
    runId: options.runId, selectedTargetHandle: opaque(context)
  });
  const suffix = hex(options.runId).slice(0, 16);
  const egress = `spawnfile-training-egress-${suffix}`;
  const container = `spawnfile-training-gateway-${suffix}`;
  const key = randomBytes(32).toString("hex");
  const mounts: string[] = [];
  const realmVolumes: string[] = [];
  for (const descriptor of descriptors) {
    const source = daimonSourcePathForEngine(descriptor.id, process.env, options.authProfile);
    await assertSafeDaimonSourceFile(source, descriptor.id, descriptor.auth.maxCredentialBytes, descriptor.id);
    const volume = trainingGatewayRealmVolume(options.authProfile.name, descriptor.id);
    realmVolumes.push(volume);
    mounts.push("--mount", `type=volume,source=${volume},target=${daimonGatewayRealmPath(descriptor)}`,
      "-v", `${source}:${daimonGatewayBootstrapMountPath(descriptor.auth.realm)}:ro`);
  }
  const stop = async (): Promise<void> => {
    await docker(["rm", "-f", container]).catch(() => undefined);
    await docker(["network", "rm", egress]).catch(() => undefined);
    await removeExactDockerResource(internal, { context, executor, timeoutMs: 30_000 }).catch(() => undefined);
  };
  const launch = async (wrap = options.script): Promise<void> => {
    const support = await mkdtemp(path.join(os.tmpdir(), "spawnfile-training-gateway-"));
    try {
      const envFile = path.join(support, "gateway.env");
      await writeFile(envFile, `${DAIMON_GATEWAY_SIDECAR_KEY_ENV}=${key}\n`, { mode: 0o600 });
      const script = renderDaimonGatewaySidecarScript(options.engines, options.runtimeRoot);
      await docker(["create", "--name", container, "--restart", "no", "--network", egress, "--label", `${LABEL}=${suffix}`,
        ...DAIMON_DOCKER_RUNTIME_SECURITY_ARGS, ...mounts, "--env-file", envFile,
        "--entrypoint", "bash", options.image, "-ceu", wrap ? wrap(script) : script]);
    } finally {
      await rm(support, { recursive: true, force: true });
    }
    await docker(["network", "connect", "--alias", DAIMON_GATEWAY_SIDECAR_ALIAS, internal.name, container]);
    await docker(["start", container]);
    await waitFor(async () => {
      const state = await docker(["inspect", "--format", "{{.State.Running}}", container]);
      if (state !== "true") {
        const logs = await docker(["logs", "--tail", "20", container]).catch(() => "");
        throw new SpawnfileError("runtime_error", `training auth gateway exited before readiness: ${logs.replace(/\s+/gu, " ").slice(-400)}`);
      }
      return docker(["exec", container, "bash", "-c", `(exec 3<>/dev/tcp/127.0.0.1/${DAIMON_GATEWAY_PORT})`]).then(() => true, () => false);
    }, options.readyTimeoutMs ?? 60_000, "training auth gateway readiness");
  };
  try {
    await executeDockerResource({ args: ["--context", context, ...internal.args], executor, timeoutMs: 30_000 });
    await docker(["network", "create", "--label", `${LABEL}=${suffix}`, egress]);
    await launch();
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    container, key, network: internal.name, realmVolumes, stop, url: DAIMON_GATEWAY_SIDECAR_URL,
    restart: async (wrap) => {
      await docker(["rm", "-f", container]);
      await launch(wrap);
    }
  };
};
