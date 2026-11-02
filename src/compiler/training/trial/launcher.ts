import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";

import type { ResolvedAuthProfile } from "../../../auth/index.js";
import { daimonGatewayedEngines } from "../../../runtime/daimon/gateway.js";
import { ensureNoopolisRunId } from "../../../runtime/index.js";
import { SpawnfileError } from "../../../shared/index.js";
import { prepareTrial, type BootedTrial, type PreparedTrial, type TrialWake } from "./boot.js";
import { createTrialDocker, type TrialDocker } from "./docker.js";
import { startTrainingGateway, trainingGatewayLogins, type TrainingGateway } from "./gateway.js";
import { JUDGE_INSTRUCTIONS, writeJudgeAgent, type JudgeSpec } from "./judge.js";

export interface BootedTrialLauncherOptions {
  /** The subject agent's own Spawnfile. */
  agentManifestPath: string;
  authProfile: ResolvedAuthProfile;
  /** Trial projects, compile outputs and boot env files live here, one fresh directory per trial. */
  scratchRoot: string;
  docker?: TrialDocker;
}

type Wake = (text: string, options: { deliveryId: string; timeoutMs: number; signal?: AbortSignal }) => Promise<TrialWake>;
type Booted = Pick<BootedTrial, "container" | "scanCredentials" | "teardown"> & { wake: Wake };

export interface BootedTrialRun {
  boot(input: { trialId: string; instructions: string }): Promise<Booted>;
  /** The run's warm judge for this engine, model and effort: booted once, woken once per judgment. */
  judge(spec: JudgeSpec): Promise<Omit<Booted, "teardown">>;
  /** Tears down every judge, stops the run's gateway and removes its image and networks; the realm volumes stay. */
  close(): Promise<void>;
}

/**
 * One training run's containers: each trial boot compiles and starts the
 * subject's one-agent organization, each judge is a tool-free one-agent
 * organization booted the same way, and all of them share the run's single
 * auth gateway, started from the first image on first use. The gateway holds
 * every gatewayed login of the run's auth profile, so trials and judges on
 * any engine reach it with one key.
 */
export const createBootedTrialRun = (options: BootedTrialLauncherOptions): BootedTrialRun => {
  const docker = options.docker ?? createTrialDocker();
  const runId = ensureNoopolisRunId();
  const logins = trainingGatewayLogins(options.authProfile);
  let gateway: Promise<{ gateway: TrainingGateway; image: string }> | undefined;
  const judges = new Map<string, Promise<Booted>>();
  let closed = false;

  const start = async (prepared: PreparedTrial): Promise<Booted> => {
    try {
      const missing = daimonGatewayedEngines(prepared.engines).filter((descriptor) => !logins.includes(descriptor.id));
      if (missing.length > 0) {
        throw new SpawnfileError("validation_error", `Auth profile ${options.authProfile.name} has no ${missing.map(({ id }) => id).join(", ")} login; run \`spawnfile auth import <engine> --profile ${options.authProfile.name}\``);
      }
      gateway ??= (async () => {
        const image = `spawnfile-training-gateway:${runId.replace(/[^A-Za-z0-9_.-]/gu, "-").slice(0, 100)}`;
        await docker(["tag", prepared.image, image]);
        return { image, gateway: await startTrainingGateway({ authProfile: options.authProfile, docker, engines: logins,
          image, runId, runtimeRoot: prepared.runtimeRoot }) };
      })();
      const booted = await prepared.boot((await gateway).gateway);
      return { container: booted.container, scanCredentials: booted.scanCredentials, wake: booted.wake, teardown: async () => { try { await booted.teardown(); } finally { await prepared.dispose(); } } };
    } catch (error) {
      await prepared.dispose();
      throw error;
    }
  };
  const directory = async (prefix: string): Promise<string> => {
    await mkdir(options.scratchRoot, { recursive: true });
    return mkdtemp(path.join(options.scratchRoot, prefix));
  };

  return {
    boot: async ({ trialId, instructions }) => start(await prepareTrial({
      agentManifestPath: options.agentManifestPath, docker, instructions, trialId, directory: await directory("trial-")
    })),
    judge: (spec) => {
      if (closed) return Promise.reject(new SpawnfileError("runtime_error", "the training run is closed"));
      const key = JSON.stringify([spec.engine, spec.model, spec.effort ?? null]);
      let judge = judges.get(key);
      if (!judge) {
        judge = (async () => {
          const root = await directory("judge-");
          return start(await prepareTrial({
            agentManifestPath: await writeJudgeAgent(spec, path.join(root, "source")), docker, instructions: JUDGE_INSTRUCTIONS,
            trialId: `judge-${spec.engine}-${key}-${runId}`, directory: root
          }));
        })();
        judges.set(key, judge);
        // A failed boot is not cached: the next judgment retries it.
        judge.catch(() => { if (judges.get(key) === judge) judges.delete(key); });
      }
      return judge;
    },
    close: async () => {
      closed = true;
      const booted = await Promise.all([...judges.values()].map((judge) => judge.catch(() => undefined)));
      judges.clear();
      await Promise.all(booted.map((judge) => judge?.teardown().catch(() => undefined)));
      const started = await gateway?.catch(() => undefined);
      if (!started) return;
      await started.gateway.stop();
      await docker(["image", "rm", "-f", started.image]).catch(() => undefined);
    }
  };
};
