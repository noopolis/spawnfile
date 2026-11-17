import { closeSync, constants, openSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { resolveSpawnfileHome } from "../../../auth/index.js";
import { slugify } from "../../helpers.js";
import { SpawnfileError } from "../../../shared/index.js";
import { createTrialDocker, type TrialDocker } from "./docker.js";

export interface TrainingRealmLockOptions {
  /** The auth profile whose login the run's gateway will hold. */
  profile: string;
  /** `wait` queues behind the holder (default); `fail` refuses at once. */
  mode?: "wait" | "fail";
  /** What this run is, for the next run's message (its output directory). */
  label: string;
  /** Lock directory (default `<spawnfile home>/training-locks`). */
  directory?: string;
  /** How often a waiting run asks again (default 2 s) and how often it says it is still waiting (default 5 min). */
  pollMs?: number;
  noticeMs?: number;
  report?: (line: string) => void;
  signal?: AbortSignal;
}

interface Holder { pid: number; label: string; since: string; containers?: string[]; networks?: string[] }

/** The held realm: `own` notes each container and network the run starts, so a successor can remove them if it dies. */
export interface TrainingRealmLock {
  /** A previous holder that died without releasing: the containers and networks it left. */
  stale?: { pid: number; label: string; containers: string[]; networks: string[] };
  own(resource: { container?: string; network?: string }): Promise<void>;
  release(): Promise<void>;
}

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};

/**
 * One training run per auth profile at a time. A profile's gatewayed login is one realm volume that a run's gateway
 * holds under an exclusive lock, so a second run's gateway cannot start and every one of its trials and judgments
 * fails. This lock queues the second run instead. It is an OS lock held by SQLite on a file nobody else opens, so it
 * is released when the holding process ends, however it ends; the holder note beside it is only for the message.
 */
export const createTrainingRealmLock = async (options: TrainingRealmLockOptions): Promise<TrainingRealmLock> => {
  const directory = options.directory ?? path.join(resolveSpawnfileHome(), "training-locks");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const name = slugify(options.profile) || "profile";
  const file = path.join(directory, `${name}.lock.sqlite`);
  const note = path.join(directory, `${name}.holder.json`);
  // Create without keeping a descriptor: closing one this process opened itself would drop SQLite's POSIX lock.
  try { closeSync(openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(file);
  database.exec("PRAGMA busy_timeout = 0");
  const holder = async (): Promise<string> => {
    const held = await readFile(note, "utf8").then((text) => JSON.parse(text) as Holder, () => undefined);
    return held ? `pid ${held.pid} (${held.label}) since ${held.since}` : "another process";
  };
  let lastNotice = Number.NEGATIVE_INFINITY;
  try {
    for (;;) {
      try { database.exec("BEGIN EXCLUSIVE"); break; } catch (error) {
        if ((error as { errcode?: number }).errcode !== 5) throw error;
      }
      if (options.mode === "fail") {
        throw new SpawnfileError("runtime_error", `Training realm of auth profile ${options.profile} is held by ${await holder()}; one run per login at a time (wait with --realm-lock wait)`);
      }
      if (options.signal?.aborted) throw new SpawnfileError("runtime_error", `Cancelled waiting for the training realm of auth profile ${options.profile}`);
      if (performance.now() - lastNotice >= (options.noticeMs ?? 300_000)) {
        lastNotice = performance.now();
        options.report?.(`training realm of auth profile ${options.profile} is held by ${await holder()}; waiting for it`);
      }
      await delay(options.pollMs ?? 2_000, undefined, options.signal ? { signal: options.signal } : {}).catch(() => undefined);
    }
  } catch (error) {
    database.close();
    throw error;
  }
  // A note still here while the lock is free belongs to a run that died holding it.
  const previous = await readFile(note, "utf8").then((text) => JSON.parse(text) as Holder, () => undefined);
  const stale = previous && previous.pid !== process.pid && !alive(previous.pid)
    ? { pid: previous.pid, label: previous.label, containers: previous.containers ?? [], networks: previous.networks ?? [] } : undefined;
  const mine: Holder = { pid: process.pid, label: options.label, since: new Date().toISOString(), containers: [], networks: [] };
  const save = (): Promise<void> => writeFile(note, `${JSON.stringify(mine)}\n`, { mode: 0o600 });
  await save();
  let released = false;
  let writes: Promise<void> = Promise.resolve();
  return {
    ...(stale ? { stale } : {}),
    own: (resource) => {
      if (resource.container && !mine.containers!.includes(resource.container)) mine.containers!.push(resource.container);
      if (resource.network && !mine.networks!.includes(resource.network)) mine.networks!.push(resource.network);
      writes = writes.then(() => released ? undefined : save(), () => undefined);
      return writes;
    },
    release: async () => {
      if (released) return;
      released = true;
      await writes.catch(() => undefined);
      const current = await readFile(note, "utf8").then((text) => JSON.parse(text) as Holder, () => undefined);
      if (current?.pid === mine.pid && current.since === mine.since) await rm(note, { force: true });
      database.close();
    }
  };
};

/** Removes what a dead holder left (its gateway still holds the realm, so no new gateway could start), then its networks. */
export const removeStaleRun = async (stale: NonNullable<TrainingRealmLock["stale"]>, docker: TrialDocker = createTrialDocker()): Promise<void> => {
  for (const container of stale.containers) await docker(["rm", "-f", container]).catch(() => undefined);
  for (const network of stale.networks) await docker(["network", "rm", network]).catch(() => undefined);
};
