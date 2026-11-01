import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";

import type { ResolvedAuthProfile } from "../../../auth/index.js";
import { ensureNoopolisRunId } from "../../../runtime/index.js";
import { prepareTrial, type TrialWake } from "./boot.js";
import { createTrialDocker, type TrialDocker } from "./docker.js";
import { startTrainingGateway, type TrainingGateway } from "./gateway.js";

export interface BootedTrialLauncherOptions {
  /** The subject agent's own Spawnfile. */
  agentManifestPath: string;
  authProfile: ResolvedAuthProfile;
  /** Trial projects, compile outputs and boot env files live here, one fresh directory per trial. */
  scratchRoot: string;
  docker?: TrialDocker;
}

export interface BootedTrialRun {
  boot(input: { trialId: string; instructions: string }): Promise<{
    wake(text: string, options: { deliveryId: string; timeoutMs: number; signal?: AbortSignal }): Promise<TrialWake>;
    teardown(): Promise<void>;
  }>;
  /** Stops the run's gateway and removes its image and networks; the realm volume stays. */
  close(): Promise<void>;
}

/**
 * One training run's trials: each boot compiles and starts the subject's
 * one-agent organization, and every trial shares the run's single auth
 * gateway, started from the first trial's image on first use.
 */
export const createBootedTrialRun = (options: BootedTrialLauncherOptions): BootedTrialRun => {
  const docker = options.docker ?? createTrialDocker();
  const runId = ensureNoopolisRunId();
  let gateway: Promise<{ gateway: TrainingGateway; image: string }> | undefined;
  return {
    boot: async ({ trialId, instructions }) => {
      await mkdir(options.scratchRoot, { recursive: true });
      const prepared = await prepareTrial({ agentManifestPath: options.agentManifestPath, docker, instructions, trialId,
        directory: await mkdtemp(path.join(options.scratchRoot, "trial-")) });
      try {
        gateway ??= (async () => {
          const image = `spawnfile-training-gateway:${runId.replace(/[^A-Za-z0-9_.-]/gu, "-").slice(0, 100)}`;
          await docker(["tag", prepared.image, image]);
          return { image, gateway: await startTrainingGateway({ authProfile: options.authProfile, docker, engines: prepared.engines,
            image, runId, runtimeRoot: prepared.runtimeRoot }) };
        })();
        const booted = await prepared.boot((await gateway).gateway);
        return { wake: booted.wake, teardown: async () => { try { await booted.teardown(); } finally { await prepared.dispose(); } } };
      } catch (error) {
        await prepared.dispose();
        throw error;
      }
    },
    close: async () => {
      const started = await gateway?.catch(() => undefined);
      if (!started) return;
      await started.gateway.stop();
      await docker(["image", "rm", "-f", started.image]).catch(() => undefined);
    }
  };
};
