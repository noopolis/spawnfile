import { appendFile, mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";

import type { ResolvedAuthProfile } from "../../../auth/index.js";
import { daimonGatewayedEngines } from "../../../runtime/daimon/gateway.js";
import { getDaimonEngineDescriptor } from "../../../runtime/daimon/index.js";
import { ensureNoopolisRunId } from "../../../runtime/index.js";
import { SpawnfileError } from "../../../shared/index.js";
import { prepareTrial, type BootedTrial, type PreparedTrial, type TrialWake } from "./boot.js";
import { createTrialDocker, type TrialDocker } from "./docker.js";
import { startTrainingGateway, trainingGatewayLogins, type TrainingGateway } from "./gateway.js";
import { JUDGE_INSTRUCTIONS, writeJudgeAgent, type JudgeSpec } from "./judge.js";
import { HOME_LOGIN_FILES } from "./homeLogin.js";
import { createRealmTurns, type RealmTurns } from "./realmTurns.js";
import { createTrialImages, timed, type TrialPhaseSink } from "./boot.js";
import { cachedTrial } from "./cache/session.js";
import { trialBaseKey } from "./cache/digest.js";
import type { TrialCacheMode, TrialCacheStore } from "./cache/store.js";
import { createJudgePool } from "./judgePool.js";

export interface BootedTrialLauncherOptions {
  /** The subject agent's own Spawnfile; absent for a judges-only run (a regrade), which can boot no trial. */
  agentManifestPath?: string;
  /** The subject's project root manifest; its team context compiles with the subject. */
  projectManifestPath?: string;
  authProfile: ResolvedAuthProfile;
  /** Trial projects, compile outputs and boot env files live here, one fresh directory per trial. */
  scratchRoot: string;
  docker?: TrialDocker;
  turns?: RealmTurns;
  /** Compiles and builds one organization (tests only). */
  prepare?: typeof prepareTrial;
  /** Bound on a judge's wait for a volume-held login another container holds (default 30 minutes). */
  judgeRealmWaitMs?: number;
  /** Reuse of identical earlier trials (`cache/`); absent: every trial boots. */
  cache?: { store: TrialCacheStore; mode: TrialCacheMode };
  /** Warm judge containers per judge identity, booted only while every one is busy (default 1). */
  judgeConcurrency?: number;
  /** The operator's channel for cache decisions. */
  report?: (line: string) => void;
  /** Notes every container and network the run starts (the realm lock keeps them for cleanup after a crash). */
  own?: (resource: { container?: string; network?: string }) => void | Promise<void>;
}

type Wake = (text: string, options: { deliveryId: string; timeoutMs: number; signal?: AbortSignal }) => Promise<TrialWake>;
type Booted = Pick<BootedTrial, "container" | "read" | "scanCredentials" | "teardown"> & { wake: Wake };

export interface BootedTrialRun {
  /** `evidenceDirectory`: where the trial's container log and engine records are kept before teardown (default: under the scratch root). */
  boot(input: { trialId: string; instructions: string; moment?: unknown; signal?: AbortSignal; evidenceDirectory?: string }): Promise<Booted>;
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
  const turns = options.turns ?? createRealmTurns();
  const prepare = options.prepare ?? prepareTrial;
  const runId = ensureNoopolisRunId();
  const logins = trainingGatewayLogins(options.authProfile);
  let gateway: Promise<{ gateway: TrainingGateway; image: string }> | undefined;
  const judges = new Map<string, Promise<Booted>>();
  const images = createTrialImages(docker);
  let closed = false;
  /** Phase durations of every trial and judge, one JSON line each, beside the run's evidence. */
  const phases = (id: string): TrialPhaseSink => (phase, ms) => {
    void appendFile(path.join(options.scratchRoot, "phases.jsonl"), `${JSON.stringify({ id, phase, ms, at: new Date().toISOString() })}\n`).catch(() => undefined);
  };
  const directory = async (prefix: string): Promise<string> => {
    await mkdir(path.dirname(path.join(options.scratchRoot, prefix)), { recursive: true });
    return mkdtemp(path.join(options.scratchRoot, prefix));
  };

  /** The gateway this organization needs (null: no gatewayed engine), started on first use. */
  const gatewayFor = async (prepared: PreparedTrial): Promise<TrainingGateway | null> => {
    const gatewayed = daimonGatewayedEngines(prepared.engines);
    if (gatewayed.length === 0) return null;
    const missing = gatewayed.filter((descriptor) => !logins.includes(descriptor.id));
    if (missing.length > 0) {
      throw new SpawnfileError("validation_error", `Auth profile ${options.authProfile.name} has no ${missing.map(({ id }) => id).join(", ")} login; run \`spawnfile auth import <engine> --profile ${options.authProfile.name}\``);
    }
    gateway ??= (async () => {
      await prepared.build?.();
      const image = `spawnfile-training-gateway:${runId.replace(/[^A-Za-z0-9_.-]/gu, "-").slice(0, 100)}`;
      await docker(["tag", prepared.image, image]);
      const started = await startTrainingGateway({ authProfile: options.authProfile, docker, engines: logins,
        image, runId, runtimeRoot: prepared.runtimeRoot, evidenceDirectory: await directory("evidence/gateway-") });
      await options.own?.({ container: started.container, network: started.network });
      await options.own?.({ network: started.container.replace("spawnfile-training-gateway-", "spawnfile-training-egress-") });
      return { image, gateway: started };
    })();
    return (await gateway).gateway;
  };
  /**
   * The volume-held login (`spawnfile auth login`) this organization mounts,
   * as a profile view that carries nothing else: no env, no imports.
   */
  const realmFor = (prepared: PreparedTrial): { volume: string; profile: ResolvedAuthProfile } | undefined => {
    const engine = prepared.engines.find((id) => getDaimonEngineDescriptor(id)?.auth.staging === "secret-service");
    if (engine === undefined) return undefined;
    const binding = options.authProfile.realms?.[engine];
    // A login recorded before its home login files were kept cannot enroll a fresh home.
    if (!binding || (HOME_LOGIN_FILES[engine] !== undefined && binding.homeVolume === undefined)) {
      throw new SpawnfileError("validation_error", `Auth profile ${options.authProfile.name} has no ${engine} login; run \`spawnfile auth login ${engine} --profile ${options.authProfile.name}\``);
    }
    return { volume: binding.realmVolume, profile: { ...options.authProfile, env: {}, imports: {}, realms: { [engine]: binding } } };
  };
  /** Boots one container, holding its login realm's turn (if any) until the container is gone. */
  const bootContainer = async (prepared: PreparedTrial, kind: "trial" | "judge", turn: { onContended?: () => void; timeoutMs?: number; signal?: AbortSignal } = {}, moment?: unknown, evidence?: string): Promise<Booted> => {
    const access = await gatewayFor(prepared);
    const realm = realmFor(prepared);
    const release = realm ? await turns.take(realm.volume, turn) : undefined;
    try {
      // Every boot keeps its own evidence: a judge that hands its realm turn over boots again, into a new directory.
      const evidenceDirectory = evidence ?? await directory(`evidence/${kind}-`);
      if (prepared.container) await options.own?.({ container: prepared.container });
      const booted = await prepared.boot(access, { evidenceDirectory, ...(realm ? { realms: realm.profile } : {}), ...(moment === undefined ? {} : { moment }) });
      return { ...booted, teardown: async () => { try { return await booted.teardown(); } finally { release?.(); } } };
    } catch (error) {
      release?.();
      throw error;
    }
  };
  const start = async (prepared: PreparedTrial, kind: "trial" | "judge", signal?: AbortSignal, moment?: unknown, evidence?: string, phase?: TrialPhaseSink): Promise<Booted> => {
    try {
      const booted = await bootContainer(prepared, kind, signal ? { signal } : {}, moment, evidence);
      return { ...booted, wake: (text, wakeOptions) => timed(phase, "wake", () => booted.wake(text, wakeOptions)), teardown: async () => {
        try {
          // Evidence that no login reached the trial: every credential-shaped file it holds, recorded before removal.
          const found = await booted.scanCredentials().catch((error: Error) => [`scan failed: ${error.message}`]);
          await appendFile(path.join(options.scratchRoot, "credential-scan.jsonl"), `${JSON.stringify({ container: booted.container, found })}\n`).catch(() => undefined);
          return await booted.teardown();
        } finally { await prepared.dispose(); }
      } };
    } catch (error) {
      await prepared.dispose();
      throw error;
    }
  };
  /**
   * A judge on a volume-held login takes turns with the run's trials: it stays
   * warm while nobody else waits for the realm, and hands the turn over (its
   * container removed) after its current judgment once someone does. Its image
   * is built once and kept.
   */
  const takeTurnsJudge = (prepared: PreparedTrial): Booted => {
    let booted: Promise<Booted> | undefined;
    let container = "";
    let busy = 0;
    let evict = false;
    const down = async (): Promise<string | null> => {
      const current = booted;
      booted = undefined;
      evict = false;
      return await (await current?.catch(() => undefined))?.teardown() ?? null;
    };
    const timeoutMs = options.judgeRealmWaitMs ?? 30 * 60_000;
    return {
      get container() { return container; },
      scanCredentials: async () => (await booted?.catch(() => undefined))?.scanCredentials() ?? [],
      read: async (file) => (await booted?.catch(() => undefined))?.read(file) ?? null,
      wake: async (text, wakeOptions) => {
        busy++;
        try {
          if (!booted) {
            const pending = bootContainer(prepared, "judge", { timeoutMs, ...(wakeOptions.signal ? { signal: wakeOptions.signal } : {}),
              onContended: () => { evict = true; if (busy === 0) void down(); } });
            booted = pending;
            pending.then((judge) => { container = judge.container; }, () => { if (booted === pending) booted = undefined; });
          }
          return await (await booted).wake(text, wakeOptions);
        } finally {
          busy--;
          if (evict && busy === 0) await down();
        }
      },
      teardown: async () => { try { return await down(); } finally { await prepared.dispose(); } }
    };
  };

  return {
    boot: async ({ trialId, instructions, moment, signal, evidenceDirectory }) => {
      const phase = phases(trialId);
      const evidence = evidenceDirectory ?? await directory("evidence/trial-");
      const prepared = await prepare({
        agentManifestPath: options.agentManifestPath ?? (() => { throw new SpawnfileError("runtime_error", "this run boots judges only; it has no subject to boot"); })(), docker, instructions, trialId, directory: await directory("trial-"),
        images, phase, ...(options.projectManifestPath ? { projectManifestPath: options.projectManifestPath } : {})
      });
      const live = (): Promise<Booted> => start(prepared, "trial", signal, moment, evidence, phase);
      if (!options.cache || prepared.digest === undefined) return live();
      return cachedTrial({ store: options.cache.store, mode: options.cache.mode, trialId, base: trialBaseKey(prepared.digest, moment),
        evidenceDirectory: evidence, boot: live, discard: () => prepared.dispose(), ...(options.report ? { report: options.report } : {}) });
    },
    judge: (spec) => {
      if (closed) return Promise.reject(new SpawnfileError("runtime_error", "the training run is closed"));
      const key = JSON.stringify([spec.engine, spec.model, spec.effort ?? null]);
      let judge = judges.get(key);
      if (!judge) {
        let member = 0;
        const prepareJudge = async () => {
          const root = await directory("judge-");
          return prepare({
            agentManifestPath: await writeJudgeAgent(spec, path.join(root, "source")), docker, instructions: JUDGE_INSTRUCTIONS,
            trialId: `judge-${spec.engine}-${key}-${runId}${member++ === 0 ? "" : `-${member}`}`, directory: root, images, phase: phases(`judge-${spec.engine}`)
          });
        };
        judge = (async () => {
          const prepared = await prepareJudge();
          let turnTaking: boolean;
          try { turnTaking = realmFor(prepared) !== undefined; } catch (error) { await prepared.dispose(); throw error; }
          if (turnTaking) return takeTurnsJudge(prepared);
          // A judge wakes one judgment at a time, so judgments in parallel need more judges: one more boots only when all are busy.
          const first = start(prepared, "judge");
          await first;
          return createJudgePool(options.judgeConcurrency ?? 1, (index) => index === 0 ? first : prepareJudge().then((next) => start(next, "judge")));
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
      await images.close();
      if (!started) return;
      await started.gateway.stop();
      await docker(["image", "rm", "-f", started.image]).catch(() => undefined);
    }
  };
};
