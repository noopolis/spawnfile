import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename } from "node:fs/promises";
import path from "node:path";
import { parseDetachedContainerInspect } from "../../runProjectDocker.js";
import { trainingOutputCopyProgram } from "./outputCopy.js";

type DockerCall = (args: string[], cleanup?: boolean) => Promise<{ code: number; stdout: string; stderr: string }>;
const ownerLabel = "com.spawnfile.training.owner";
const inspectFormat = "{{json .Id}}\n{{json .Name}}\n{{json .Image}}\n{{json .Config.Labels}}";
const target = "/run/training/output";

export const trainingOutputVolumeEnabled = (): boolean => {
  const setting = process.env.SPAWNFILE_TRAINING_OUTPUT_STORAGE;
  if (setting !== undefined && setting !== "volume" && setting !== "bind") throw Error("SPAWNFILE_TRAINING_OUTPUT_STORAGE must be volume or bind");
  return setting !== "bind";
};

/** One launch owns this volume; budgets and auth volumes are never touched. */
export const createTrainingOutputVolume = (options: {
  name: string; image: string; host: string; scratch: string; uid: number; gid: number;
  runtimeUid: number; runtimeGid: number; context: string; call: DockerCall; stderr(line: string): void;
}) => {
  const { call } = options;
  const volume = `${options.name}-output`;
  let attempted = false, seeded = false, exported = false, exportAttempted = false, helperClosed = true;
  const recovery = (): string => `Training output retained in Docker volume ${volume}. Recover with: docker --context ${options.context} run --rm --network none --read-only --mount type=volume,src=${volume},dst=/output,readonly --entrypoint /bin/tar ${options.image} -C /output -cpf - . > training-output-recovery.tar`;
  const owned = async (): Promise<boolean> => {
    const result = await call(["volume", "inspect", volume, "--format", "{{json .}}"], true);
    if (result.code !== 0) {
      const listed = await call(["volume", "ls", "--filter", `name=^${volume}$`, "--format", "{{.Name}}"], true);
      if (listed.code === 0 && !listed.stdout.trim()) return false;
      throw Error("Training output volume closure is unknown");
    }
    const info = JSON.parse(result.stdout) as { Name?: unknown; Driver?: unknown; Options?: unknown; Labels?: Record<string, unknown> };
    if (info.Name !== volume || info.Driver !== "local" || (info.Options && Object.keys(info.Options).length) || info.Labels?.[ownerLabel] !== options.name) throw Error("Refusing unverified training output volume");
    return true;
  };
  const transfer = async (direction: "seed" | "export"): Promise<void> => {
    if (!await owned()) throw Error("Training output volume is missing");
    const name = `${volume}-${direction}`;
    const labels = { [ownerLabel]: name };
    const hostStage = path.join(options.scratch, "output-export");
    if (direction === "export") await mkdir(hostStage, { mode: 0o700 });
    const mounts = direction === "seed"
      ? [`type=bind,src=${options.host},dst=/source,readonly`, `type=volume,src=${volume},dst=/destination,volume-nocopy`]
      : [`type=volume,src=${volume},dst=/source,readonly,volume-nocopy`, `type=bind,src=${hostStage},dst=/destination`];
    let creationAttempted = false, containerId: string | undefined;
    try {
      creationAttempted = true; helperClosed = false;
      const created = await call(["container", "create", "--name", name, "--label", `${ownerLabel}=${name}`,
        "--network", "none", "--read-only", "--user", "0:0", "--security-opt", "no-new-privileges",
        // Retain only Docker's default CHOWN, DAC_OVERRIDE, FOWNER and FSETID for copying
        // private runtime files and assigning the native/broker uid. No cap-add.
        ...["AUDIT_WRITE", "KILL", "MKNOD", "NET_BIND_SERVICE", "NET_RAW", "SETFCAP", "SETGID", "SETPCAP", "SETUID", "SYS_CHROOT"].flatMap(cap => ["--cap-drop", cap]),
        "--pids-limit", "32", "--memory", "256m", "--cpus", "1", "--workdir", "/",
        ...mounts.flatMap(mount => ["--mount", mount]), "--entrypoint", "node", options.image,
        "-e", trainingOutputCopyProgram, "/source", "/destination",
        String(direction === "seed" ? options.runtimeUid : options.uid), String(direction === "seed" ? options.runtimeGid : options.gid)], direction === "export");
      const id = created.stdout.trim(); containerId = id;
      if (created.code !== 0 || !/^[a-f0-9]{64}$/u.test(id)) throw Error(`Cannot create training output ${direction} helper`);
      const checked = await call(["container", "inspect", "--format", inspectFormat, name], true);
      if (checked.code !== 0 || parseDetachedContainerInspect(checked.stdout, id, labels, name).imageId !== options.image) throw Error("Training output helper identity mismatch");
      const result = await call(["container", "start", "--attach", id], direction === "export");
      const terminal = await call(["container", "inspect", "--format", "{{json .State}}", id], true);
      const state = JSON.parse(terminal.stdout) as { Running?: unknown; ExitCode?: unknown };
      if (result.code !== 0 || result.stdout.trim() !== "spawnfile-output-copy-complete" || terminal.code !== 0 || state.Running !== false || state.ExitCode !== 0) throw Error(`Training output ${direction} failed (copy incomplete or exceeds limits): ${result.stderr.replace(/\p{Cc}/gu, " ").slice(0, 2048)}`);
    } finally {
      if (creationAttempted) {
        const found = await call(["container", "inspect", "--format", inspectFormat, name], true);
        if (found.code === 0) {
          const id: unknown = JSON.parse(found.stdout.split("\n")[0]!);
          if (typeof id !== "string" || parseDetachedContainerInspect(found.stdout, id, labels, name).imageId !== options.image || (containerId && /^[a-f0-9]{64}$/u.test(containerId) && id !== containerId)) throw Error("Refusing cleanup of unverified training output helper");
          const removed = await call(["container", "rm", "--force", id], true);
          if (removed.code !== 0) throw Error("Cannot remove training output helper");
        }
        const remaining = await call(["container", "ls", "--all", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"], true);
        if (remaining.code !== 0 || remaining.stdout.trim()) throw Error("Training output helper closure is unknown");
        helperClosed = true;
      }
    }
    if (direction === "export") {
      if (await realpath(options.host) !== options.host || !(await lstat(options.host)).isDirectory()) throw Error("Training host output changed before export");
      const backup = path.join(options.scratch, "output-before-export");
      await rename(options.host, backup);
      try { await rename(hostStage, options.host); }
      catch (error) { await rename(backup, options.host); throw error; }
      for (const directory of [options.scratch, path.dirname(options.host)]) {
        const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await handle.sync(); } finally { await handle.close(); }
      }
    }
  };
  return {
    safeToCleanup: (): boolean => helperClosed && (!exportAttempted || exported),
    mount: `type=volume,src=${volume},dst=${target},volume-nocopy`,
    async seed(): Promise<void> {
      attempted = true;
      const created = await call(["volume", "create", "--driver", "local", "--label", `${ownerLabel}=${options.name}`, volume]);
      if (created.code !== 0 || created.stdout.trim() !== volume || !await owned()) throw Error("Cannot create owned training output volume");
      await transfer("seed"); seeded = true;
      options.stderr(`Training output uses VM-local volume ${volume}; host checkpoints update at exit.`);
    },
    async export(): Promise<void> {
      if (!seeded || exportAttempted) return;
      exportAttempted = true;
      try { await transfer("export"); exported = true; }
      catch (error) { options.stderr(`Training output export failed: ${error instanceof Error ? error.message : "unknown failure"}. Scratch retained at ${options.scratch}. ${recovery()}`); throw Error(`Training output export failed. ${recovery()}`, { cause: error }); }
    },
    async dispose(closureVerified: boolean): Promise<void> {
      if (!attempted) return;
      try {
        if (!await owned()) return;
        if (!helperClosed) throw Error("Training output helper closure is unverified");
        if (!closureVerified) { options.stderr(recovery()); return; }
        if (seeded && !exported) throw Error("Training output has not been exported");
        const removed = await call(["volume", "rm", volume], true);
        const remaining = await call(["volume", "ls", "--filter", `name=^${volume}$`, "--format", "{{.Name}}"], true);
        if (removed.code !== 0 || remaining.code !== 0 || remaining.stdout.trim()) throw Error("Training output volume removal is unverified");
      } catch (error) { options.stderr(recovery()); throw Error(recovery(), { cause: error }); }
    }
  };
};
