import { spawn } from "node:child_process";

import { SpawnfileError } from "../shared/index.js";

const OUTPUT_TAIL = 4_096;

export interface BundleCommand {
  argv: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
}

/** Runs one build step; resolves with stdout, fails with the stderr tail on a non-zero exit, a signal or the timeout. */
export const runBundleCommand = (command: BundleCommand, label: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const [file, ...args] = command.argv;
    const child = spawn(file!, args, { cwd: command.cwd, env: command.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, command.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-OUTPUT_TAIL); });
    child.once("error", (error) => { clearTimeout(timer); reject(new SpawnfileError("compile_error", `${label} could not start ${file}: ${error.message}`)); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) { resolve(stdout); return; }
      const why = timedOut ? `timed out after ${command.timeoutMs} ms` : signal ? `was killed by ${signal}` : `exited ${code}`;
      reject(new SpawnfileError("compile_error", `${label} ${why}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
    });
  });

export interface ContainerStep {
  dockerCommand: string;
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
    step.dockerCommand, "run", "--rm", "--platform", step.platform, ...user,
    ...(step.network === false ? ["--network", "none"] : []),
    ...step.mounts.flatMap(([host, container]) => ["--volume", `${host}:${container}`]),
    "--workdir", step.workdir,
    ...Object.entries(env).sort(([left], [right]) => left.localeCompare(right)).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    step.image, ...step.argv
  ];
};
