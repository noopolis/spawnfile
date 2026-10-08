import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

import { SpawnfileError } from "../shared/index.js";

const OUTPUT_TAIL = 4_096;

export interface BundleCommand {
  argv: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** A container this step starts by name; removed (forcefully) if the step times out or fails. */
  container?: { dockerCommand: string; name: string };
}

const CLEANUP_TIMEOUT_MS = 30_000;

/** Best-effort, bounded: a stalled Docker client is killed so cleanup never outlives its deadline. */
const removeContainer = (container: NonNullable<BundleCommand["container"]>): Promise<void> => new Promise((resolve) => {
  const child = spawn(container.dockerCommand, ["rm", "--force", container.name], { stdio: "ignore" });
  const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, CLEANUP_TIMEOUT_MS);
  const done = (): void => { clearTimeout(timer); resolve(); };
  child.once("error", done);
  child.once("close", done);
});

/**
 * Runs one build step in its own process group; resolves with stdout, fails
 * with the stderr tail on a non-zero exit, a signal or the timeout. A timeout
 * kills the whole group, and a named container is removed, so neither stray
 * descendants nor a detached container outlive the step.
 */
export const runBundleCommand = (command: BundleCommand, label: string): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const [file, ...args] = command.argv;
    const child = spawn(file!, args, { cwd: command.cwd, detached: true, env: command.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    let stderr = "", timedOut = false, settled = false;
    const killGroup = (): void => { try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); } };
    const finish = async (error?: SpawnfileError): Promise<void> => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error && command.container) await removeContainer(command.container);
      if (error) reject(error); else resolve(Buffer.concat(stdout));
    };
    const timer = setTimeout(() => { timedOut = true; killGroup(); void finish(new SpawnfileError("compile_error", `${label} timed out after ${command.timeoutMs} ms${stderr.trim() ? `: ${stderr.trim()}` : ""}`)); }, command.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout.push(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-OUTPUT_TAIL); });
    child.once("error", (error) => { void finish(new SpawnfileError("compile_error", `${label} could not start ${file}: ${error.message}`)); });
    child.once("close", (code, signal) => {
      if (timedOut) return;
      if (code === 0) { void finish(); return; }
      killGroup();
      const why = signal ? `was killed by ${signal}` : `exited ${code}`;
      void finish(new SpawnfileError("compile_error", `${label} ${why}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
    });
  });

export interface ContainerStep {
  dockerCommand: string;
  /** Container name, so a timed-out step can be removed. */
  name: string;
  image: string;
  platform: string;
  /** Host directory → container directory. */
  mounts: ReadonlyArray<readonly [string, string]>;
  workdir: string;
  env?: Record<string, string>;
  network?: boolean;
  argv: readonly string[];
}

/**
 * `docker run` for one build step on the target platform: removed on exit,
 * running as the invoking user so outputs stay owned by them, no inherited
 * host environment, and a throwaway HOME.
 */
export const containerArgv = (step: ContainerStep): string[] => {
  const user = typeof process.getuid === "function" && typeof process.getgid === "function" ? [`--user`, `${process.getuid()}:${process.getgid()}`] : [];
  const env = { HOME: "/tmp/spawnfile-home", ...step.env };
  return [
    step.dockerCommand, "run", "--rm", "--name", step.name, "--platform", step.platform, ...user,
    ...(step.network === false ? ["--network", "none"] : []),
    ...step.mounts.flatMap(([host, container]) => ["--volume", `${host}:${container}`]),
    "--workdir", step.workdir,
    ...Object.entries(env).sort(([left], [right]) => left.localeCompare(right)).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    step.image, ...step.argv
  ];
};

/** A unique container name for one build step. */
export const bundleContainerName = (): string => `spawnfile-bundle-${randomBytes(8).toString("hex")}`;

/** Runs a container step; the container is removed if the step fails or times out. */
export const runContainerStep = (step: ContainerStep, timeoutMs: number, label: string, cwd: string): Promise<Buffer> =>
  runBundleCommand({ argv: containerArgv(step), container: { dockerCommand: step.dockerCommand, name: step.name }, cwd, timeoutMs }, label);
